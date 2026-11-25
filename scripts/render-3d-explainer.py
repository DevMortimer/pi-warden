#!/usr/bin/env python3
"""Render the pi-warden 3D explainer film with Blender Cycles on an NVIDIA GPU host.

    python3 scripts/render-3d-explainer.py --mode keyframes      # graded 1080p stills + contact sheet
    python3 scripts/render-3d-explainer.py --mode full           # 1920x1080 60 fps MP4 with sound, web copy, GIF, contact sheet
    python3 scripts/render-3d-explainer.py --mode chunk --range 0:779
    python3 scripts/render-3d-explainer.py --mode assemble       # joins chunks rendered on several hosts
    python3 scripts/render-3d-explainer.py --mode audio          # the soundtrack alone

The driver fetches Blender 4.5 LTS and two open fonts (checksums pinned), renders the
beauty frames with `blender -b -P <this file> -- --blender ...`, composites the titles
with Pillow, synthesizes the soundtrack with numpy and scipy, and encodes with ffmpeg.
Every number and claim on screen is stated in README.md.
"""
import argparse
import bisect
import hashlib
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path

try:
    import bmesh
    import bpy
    from mathutils import Matrix, Vector
except ImportError:
    bpy = None

FPS = 60
WIDTH, HEIGHT = 1920, 1080
DURATION = 26.0
FRAME_COUNT = round(DURATION * FPS)
SAMPLE_RATE = 48000
AUDIO_KBPS = 192

BLENDER_VERSION = "4.5.17"
BLENDER_URL = f"https://download.blender.org/release/Blender4.5/blender-{BLENDER_VERSION}-linux-x64.tar.xz"
BLENDER_SHA256 = "b7d09d1aa7c346fed1e56390e815dbf1589d47324734fbad9e2007fe75ca0b8d"
INTER_URL = "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip"
INTER_SHA256 = "9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e"
MONO_URL = "https://raw.githubusercontent.com/JetBrains/JetBrainsMono/v2.304/fonts/ttf/JetBrainsMono-Bold.ttf"
MONO_SHA256 = "5590990c82e097397517f275f430af4546e1c45cff408bde4255dad142479dcb"
FONTS = {
    "black": "InterDisplay-Black.ttf",
    "heavy": "InterDisplay-ExtraBold.ttf",
    "semi": "InterDisplay-SemiBold.ttf",
    "mono": "JetBrainsMono-Bold.ttf",
}

GATE_X = 5.2
SHIELD_X = GATE_X - 0.16
PORT_X = 7.0
SPAWN_X = -10.9
SINK_X = 8.3
RAIL_X = (-10.0, 7.0)
RAIL_TOP = 0.62
PLINTH_TOP = 0.48
CAP_Z = 0.95
CAP_LEN = 2.0
CAP_R = 0.26
LOOP_R = 1.45
LOOP_C = (-1.0, -LOOP_R)
S1_POS = (GATE_X, 0.0, 4.2)
LASER_FROM = (4.45, 0.0, 1.0)
LASER_DIR = (math.sqrt(0.5), 0.0, math.sqrt(0.5))
LASER_LEN = 30.0
CUT_LEN = (SHIELD_X - LASER_FROM[0]) / LASER_DIR[0]
TURN_STOP_X = 3.0

RGB = {
    "crimson": (1.0, 0.025, 0.04),
    "emerald": (0.02, 1.0, 0.3),
    "gold": (1.0, 0.55, 0.06),
    "purple": (0.42, 0.06, 1.0),
    "amber": (1.0, 0.36, 0.02),
    "ice": (0.6, 0.8, 1.0),
    "pearl": (0.78, 0.84, 0.95),
    "white": (1.0, 1.0, 1.0),
}

EV = {
    "hook_a": 0.06, "hook_b": 0.44, "hook_out": 1.16, "lights": 0.80,
    "fire_rm": 1.30, "freeze": 3.05, "gate_drop": 3.38, "gate_land": 3.55, "resume": 3.80, "shatter": 3.96,
    "cap_stop": 4.05, "cap_stop_out": 6.55,
    "fire_read": 5.15, "fire_edit": 5.95, "fire_test": 6.75,
    "env_out": 8.95, "cap_mask": 9.95, "cap_mask_out": 11.15,
    "fetch_drop": 11.30, "fetch_stop": 12.20, "laser": 12.24, "shield": 12.38, "cut": 12.43,
    "cap_leak": 12.50, "fetch_fade": 13.35, "shield_up": 13.85, "cap_leak_out": 14.20,
    "loop_start": 14.40, "switch": 16.86, "cap_loop": 17.22, "cap_loop_out": 17.95,
    "fire_turn": 17.10, "s1_pulse": 17.92, "s1_beam": 18.12, "lock": 18.30, "cap_s1": 18.36,
    "turn_fade": 19.55, "cap_s1_out": 19.90,
    "stats": 20.10, "stats_zero": 21.15, "stats_out": 22.40, "lockup": 22.70,
}
LOOP_PASSES = (14.78, 15.66, 16.46, 17.18)
COUNT_SETTLE = [EV["stats"] + 0.16 + 0.09 * k for k in range(6)]
KEYFRAMES = [0.70, 4.45, 10.55, 12.75, 17.70, 19.00, 21.60, 24.40]
CUTS = (1.62, 11.20, 14.35)
TAKE_FRAMES = [0] + [math.floor(t * FPS) + 1 for t in CUTS] + [FRAME_COUNT]


def clamp(v, lo=0.0, hi=1.0):
    return lo if v < lo else hi if v > hi else v


def lerp(a, b, u):
    return a + (b - a) * u


def mix(a, b, u):
    return tuple(lerp(x, y, u) for x, y in zip(a, b))


def span(t, t0, t1):
    if t1 <= t0:
        return 1.0 if t >= t1 else 0.0
    return clamp((t - t0) / (t1 - t0))


def smooth(u):
    u = clamp(u)
    return u * u * u * (u * (u * 6.0 - 15.0) + 10.0)


def ease_out(u, power=3.0):
    return 1.0 - (1.0 - clamp(u)) ** power


def flash(t, t0, attack=0.025, decay=0.3):
    if t < t0:
        return 0.0
    if t < t0 + attack:
        return (t - t0) / attack
    return math.exp(-(t - t0 - attack) / decay)


def window(t, t0, t1, fade_in=0.2, fade_out=0.2):
    return min(span(t, t0, t0 + fade_in), 1.0 - span(t, t1 - fade_out, t1))


class Track:
    def __init__(self, keys):
        self.scalar = not isinstance(keys[0][1], (tuple, list))
        pts = []
        for key in keys:
            value = (key[1],) if self.scalar else tuple(key[1])
            vel = key[2] if len(key) > 2 else None
            if vel is not None:
                vel = (vel,) if self.scalar else tuple(vel)
            pts.append([key[0], value, vel])
        for i, pt in enumerate(pts):
            if pt[2] is None:
                if 0 < i < len(pts) - 1:
                    (ta, pa, _), (tb, pb, _) = pts[i - 1], pts[i + 1]
                    pt[2] = tuple((b - a) / (tb - ta) for a, b in zip(pa, pb))
                else:
                    pt[2] = tuple(0.0 for _ in pt[1])
        self.pts = pts
        self.times = [p[0] for p in pts]

    def __call__(self, t):
        pts = self.pts
        if t <= pts[0][0]:
            out = pts[0][1]
        elif t >= pts[-1][0]:
            tl, pl, vl = pts[-1]
            out = tuple(p + v * (t - tl) for p, v in zip(pl, vl))
        else:
            i = bisect.bisect_right(self.times, t) - 1
            (t0, p0, m0), (t1, p1, m1) = pts[i], pts[i + 1]
            h = t1 - t0
            u = (t - t0) / h
            u2, u3 = u * u, u * u * u
            a, b, c, d = 2 * u3 - 3 * u2 + 1, u3 - 2 * u2 + u, -2 * u3 + 3 * u2, u3 - u2
            out = tuple(a * x0 + b * h * v0 + c * x1 + d * h * v1 for x0, v0, x1, v1 in zip(p0, m0, p1, m1))
        return out[0] if self.scalar else out


def cruise(t_fire, speed, start=SPAWN_X):
    return Track([(t_fire, start, 0.0), (t_fire + 0.12, start + speed * 0.06, speed)])


def arrival(t_fire, speed, x, start=SPAWN_X):
    return t_fire + 0.06 + (x - start) / speed


def on_rail(track):
    return lambda t: (track(t), 0.0, CAP_Z, 0.0)


LOOP_SPIN = Track([
    (EV["loop_start"], 1.2 * math.pi, 2 * math.pi / 0.95),
    (LOOP_PASSES[0], 2 * math.pi), (LOOP_PASSES[1], 4 * math.pi), (LOOP_PASSES[2], 6 * math.pi),
    (LOOP_PASSES[3], 8 * math.pi, 2 * math.pi / 0.70),
])
LOOP_EXIT_SPEED = LOOP_R * 2 * math.pi / 0.70


def loop_path(t):
    if t < LOOP_PASSES[3]:
        phi = LOOP_SPIN(t)
        return (LOOP_C[0] + LOOP_R * math.sin(phi), LOOP_C[1] + LOOP_R * math.cos(phi), CAP_Z, -phi)
    return (LOOP_C[0] + LOOP_EXIT_SPEED * (t - LOOP_PASSES[3]), 0.0, CAP_Z, -LOOP_SPIN(LOOP_PASSES[3]))


def capsule_specs():
    specs = []

    def add(name, label, color, show, hide, path, **extra):
        spec = dict(name=name, label=label, color=color, show=show, hide=hide, path=path, length=CAP_LEN,
                    radius=CAP_R, top_label=False, blocked=False, masked=False, recolor=None, fade=None, launched=True)
        spec.update(extra)
        specs.append(spec)

    rm = Track([(EV["fire_rm"], SPAWN_X, 0.0), (EV["fire_rm"] + 0.12, SPAWN_X + 0.65, 10.8), (2.50, 1.45, 10.8),
                (EV["freeze"], 3.88, 0.10), (EV["resume"], 3.95, 0.04), (EV["shatter"], GATE_X - CAP_LEN / 2, 3.2)])
    add("rm", "rm -rf /", "crimson", EV["fire_rm"], EV["shatter"], on_rail(rm), blocked=True)
    for name in ("read", "edit", "test"):
        t0 = EV[f"fire_{name}"]
        add(name, name, "emerald", t0, arrival(t0, 13.5, SINK_X), on_rail(cruise(t0, 13.5)))
    env = Track([(EV["env_out"], 8.9, 0.0), (9.25, 7.6, -7.0), (9.60, 6.0, -1.3), (10.85, 4.4, -1.3),
                 (11.35, 1.5, -9.0), (12.2, -7.0, -10.0)])
    add("env", ".env", "gold", EV["env_out"], 12.2, on_rail(env), length=1.6, masked=True, launched=False)
    fetch = Track([(EV["fetch_drop"], (1.6, 0.0, 9.5), (0.0, 0.0, -16.0)), (11.70, (1.6, 0.0, CAP_Z + 0.02), (0.0, 0.0, -0.4)),
                   (11.78, (1.62, 0.0, CAP_Z), (0.6, 0.0, 0.0)), (EV["fetch_stop"], (LASER_FROM[0] - 0.8, 0.0, CAP_Z), (0.0, 0.0, 0.0))])
    add("fetch", "fetch", "purple", EV["fetch_drop"], EV["cap_leak_out"], lambda t: (*fetch(t), 0.0), length=1.6,
        launched=False, dim=(EV["fetch_fade"], 0.25), fade=(EV["cap_leak_out"] - 0.35, EV["cap_leak_out"]))
    add("loop", "npm test", "crimson", EV["loop_start"], LOOP_PASSES[3] + (SINK_X - LOOP_C[0]) / LOOP_EXIT_SPEED, loop_path,
        length=1.4, radius=0.22, top_label=True, launched=False, recolor=(LOOP_PASSES[3], "emerald"))
    turn = Track([(EV["fire_turn"], SPAWN_X, 0.0), (EV["fire_turn"] + 0.12, SPAWN_X + 0.78, 13.0), (17.85, -2.0, 13.0),
                  (18.32, TURN_STOP_X, 0.0)])
    add("turn", "TURN #63", "pearl", EV["fire_turn"], EV["cap_s1_out"], on_rail(turn), recolor=(EV["lock"], "amber"),
        fade=(EV["turn_fade"], EV["cap_s1_out"]))
    flow = [(19.70, "ls", "emerald"), (20.05, "read", "emerald"), (20.40, "git push -f", "crimson"),
            (20.75, "edit", "emerald"), (21.10, "test", "emerald"), (21.50, "npm test", "emerald"),
            (21.90, "git commit", "emerald"), (22.40, "read", "emerald"), (23.00, "edit", "emerald"),
            (23.70, "test", "emerald"), (24.40, "read", "emerald"), (25.10, "edit", "emerald")]
    for i, (t0, label, color) in enumerate(flow):
        blocked = color == "crimson"
        hide = arrival(t0, 14.0, GATE_X - CAP_LEN / 2) if blocked else arrival(t0, 14.0, SINK_X)
        add(f"flow{i}", label, color, t0, min(hide, DURATION + 0.5), on_rail(cruise(t0, 14.0)), blocked=blocked)
    return specs


def crossing(spec, nose_sign=1.0):
    steps = int((spec["hide"] - spec["show"]) * 240) + 1
    prev = None
    for k in range(steps + 1):
        t = spec["show"] + k / 240.0
        nose = spec["path"](t)[0] + nose_sign * spec["length"] / 2
        if prev is not None and (prev - GATE_X) * (nose - GATE_X) <= 0 and prev != nose:
            return t
        prev = nose
    return None


SPECS = capsule_specs()
SPEC = {s["name"]: s for s in SPECS}
ENV_WINDOW = (crossing(SPEC["env"], -1.0), crossing(SPEC["env"], 1.0))


def gate_events():
    events = [(EV["gate_land"], "white", "land"), (EV["cut"], "ice", "shield"), (EV["lock"], "amber", "lock")]
    for spec in SPECS:
        if spec["blocked"]:
            events.append((spec["hide"], "crimson", "block"))
        elif spec["name"] not in ("env", "fetch", "turn"):
            t = crossing(spec)
            if t is not None:
                events.append((t, "emerald", "pass"))
    return sorted(events)


EVENTS = gate_events()
FIRES = sorted((s["show"], s["color"]) for s in SPECS if s["launched"])
GLOW_GAIN = {"land": 12.0, "block": 10.0, "pass": 5.0, "shield": 7.0, "lock": 6.0}


def gate_glow(t):
    base = 2.2 * smooth(span(t, EV["gate_land"], EV["gate_land"] + 0.25))
    weights = [(base, RGB["emerald"])]
    for te, color, kind in EVENTS:
        weights.append((GLOW_GAIN[kind] * flash(t, te, 0.02, 0.28), RGB[color]))
    weights.append((4.0 * window(t, ENV_WINDOW[0], ENV_WINDOW[1], 0.15, 0.3), RGB["gold"]))
    total = sum(w for w, _ in weights)
    if total <= 1e-6:
        return 0.0, RGB["emerald"]
    color = tuple(sum(w * c[i] for w, c in weights) / total for i in range(3))
    return total, color


def membrane_fac(t):
    land = span(t, EV["gate_land"], EV["gate_land"] + 0.2)
    pulses = sum(0.03 * GLOW_GAIN[kind] * flash(t, te, 0.02, 0.2) for te, _, kind in EVENTS)
    return clamp(0.025 * land + pulses + 0.06 * window(t, ENV_WINDOW[0], ENV_WINDOW[1], 0.1, 0.3), 0.0, 0.5)


def ring_wave(t):
    latest = None
    for te, color, kind in EVENTS:
        if kind in ("pass", "block") and te <= t < te + 0.4:
            latest = (te, color)
    if latest is None:
        return 0.0, 0.0, RGB["emerald"]
    u = (t - latest[0]) / 0.4
    return 0.7 + 0.9 * ease_out(u), 6.0 * (1 - u) ** 2, RGB[latest[1]]


def studio(t):
    on = smooth(span(t, EV["lights"], EV["lights"] + 0.16))
    blink = 1.0 - 0.4 * flash(t, EV["lights"] + 0.06, 0.01, 0.035)
    dim = lerp(1.0, 0.25, smooth(span(t, EV["lockup"], EV["lockup"] + 1.4)))
    return on * blink * dim


RIM_BEATS = [(0.0, "ice"), (1.25, "crimson"), (4.6, "emerald"), (8.9, "gold"), (11.2, "purple"), (14.35, "crimson"),
             (17.3, "amber"), (20.0, "emerald")]


def rim_color(t):
    current = RGB[RIM_BEATS[0][1]]
    for i, (tb, name) in enumerate(RIM_BEATS):
        if t >= tb:
            prev = RGB[RIM_BEATS[i - 1][1]] if i else RGB[name]
            current = mix(prev, RGB[name], smooth(span(t, tb, tb + 0.35)))
    return current


def impact_flash(t):
    return sum(flash(t, te, 0.012, 0.16) for te, _, kind in EVENTS if kind == "block")


CAM_TAKES = []


def _cam_takes():
    rm = SPEC["rm"]["path"]
    chase = [(t, (rm(t)[0] + 0.2, -6.4, 1.3), (rm(t)[0] + 1.4, 0.0, 1.0)) for t in (1.62, 1.9, 2.2, 2.5)]
    take_a = dict(pos=Track([(0.0, (-6.7, -3.9, 1.75), (0.0, 0.0, 0.0)), (1.30, (-7.2, -3.45, 1.5)), (1.62, (-6.6, -3.9, 1.45))]),
                  tgt=Track([(0.0, (-10.15, 0.2, 1.1), (0.0, 0.0, 0.0)), (1.30, (-10.0, 0.0, 1.0), (0.0, 0.0, 0.0)),
                             (1.45, (-8.3, 0.0, 1.0)), (1.62, (-5.4, 0.0, 0.95))]),
                  lens=Track([(0.0, 40.0), (1.62, 36.0)]))
    take_b = dict(pos=Track([(t, p) for t, p, _ in chase] + [
                      (EV["freeze"], (2.3, -4.6, 1.45), (0.12, 0.15, 0.0)), (4.30, (2.5, -4.35, 1.42), (0.05, 0.1, 0.0)),
                      (6.00, (-0.5, -10.5, 3.8)), (8.85, (2.0, -3.6, 1.75)), (9.60, (2.2, -3.45, 1.65)), (10.85, (1.85, -3.55, 1.6)),
                      (CUTS[1], (1.4, -3.75, 1.6), (-1.5, 0.0, 0.0))]),
                  tgt=Track([(t, g) for t, _, g in chase] + [
                      (EV["freeze"], (5.05, 0.0, 1.35), (0.0, 0.0, 0.0)), (4.30, (5.1, 0.0, 1.4), (0.0, 0.0, 0.0)),
                      (6.00, (3.4, 0.0, 1.5)), (8.85, (5.6, 0.0, 1.05)), (9.60, (5.35, 0.0, 1.0)), (10.85, (4.5, 0.0, 1.0)),
                      (CUTS[1], (3.3, 0.0, 1.0), (-2.5, 0.0, 0.0))]),
                  lens=Track([(CUTS[0], 32.0), (2.5, 34.0), (EV["freeze"], 38.0), (4.30, 38.0), (6.0, 32.0), (8.85, 36.0),
                              (CUTS[1], 36.0)]))
    take_c = dict(pos=Track([(CUTS[1], (1.2, -5.4, 1.3), (0.0, 0.0, 0.0)), (EV["fetch_stop"], (2.4, -4.8, 1.2)),
                             (CUTS[2], (2.7, -4.6, 1.2), (0.1, 0.05, 0.0))]),
                  tgt=Track([(CUTS[1], (3.4, 0.0, 2.0), (0.0, 0.0, 0.0)), (EV["fetch_stop"], (4.5, 0.0, 1.8)),
                             (CUTS[2], (4.6, 0.0, 1.8), (0.03, 0.0, 0.0))]),
                  lens=Track([(CUTS[1], 28.0), (CUTS[2], 28.0)]))
    take_d = dict(pos=Track([(CUTS[2], (-1.4, -7.4, 6.2), (0.4, 0.15, -0.2)), (17.30, (-0.2, -7.0, 5.6)), (18.10, (0.9, -8.0, 2.8)),
                             (19.95, (1.5, -7.6, 2.75)), (22.60, (-2.8, -17.0, 7.6)), (DURATION, (-2.2, -19.5, 8.8), (0.18, -0.7, 0.35))]),
                  tgt=Track([(CUTS[2], (-0.6, -1.4, 0.7), (0.35, 0.1, 0.0)), (17.30, (0.8, -1.0, 0.8)), (18.10, (4.0, 0.0, 2.55)),
                             (19.95, (4.2, 0.0, 2.5)), (22.60, (2.2, 0.0, 1.2)), (DURATION, (2.4, 0.0, 1.6), (0.05, 0.0, 0.1))]),
                  lens=Track([(CUTS[2], 38.0), (17.30, 38.0), (18.10, 34.0), (19.95, 34.0), (22.60, 28.0), (DURATION, 28.0)]))
    return [take_a, take_b, take_c, take_d]


CAM_TAKES = _cam_takes()
SHAKES = ((EV["gate_land"], 0.07, 0.14), (EV["shatter"], 0.025, 0.10), (EV["stats_zero"], 0.02, 0.12))


def camera(take, t):
    pos, tgt, lens = take["pos"](t), take["tgt"](t), take["lens"](t)
    jolt = [0.0, 0.0, 0.0]
    for t0, amp, tau in SHAKES:
        if t >= t0:
            k, u = amp * math.exp(-(t - t0) / tau), t - t0
            jolt[0] += k * math.sin(2 * math.pi * 19 * u)
            jolt[1] += 0.5 * k * math.sin(2 * math.pi * 13 * u + 1.3)
            jolt[2] += k * math.sin(2 * math.pi * 23 * u + 0.7)
    pos = tuple(p + j for p, j in zip(pos, jolt))
    tgt = tuple(g + 0.6 * j for g, j in zip(tgt, jolt))
    dist = math.dist(pos, tgt)
    lock = smooth(span(t, EV["lockup"], EV["lockup"] + 1.2))
    return pos, tgt, lens, lerp(2.8, 1.2, lock), lerp(dist, 1.6, lock)


FACE_NY = (math.pi / 2, 0.0, 0.0)
FACE_NX = (math.pi / 2, 0.0, -math.pi / 2)


def bl_link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def bl_mesh(name, build, mats=(), smooth_shade=False):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    build(bm)
    bm.to_mesh(mesh)
    bm.free()
    if smooth_shade:
        mesh.shade_smooth()
    for mat in mats:
        mesh.materials.append(mat)
    return mesh


def bl_object(name, data, loc=(0.0, 0.0, 0.0), rot=(0.0, 0.0, 0.0), parent=None):
    obj = bl_link(bpy.data.objects.new(name, data))
    obj.location = loc
    obj.rotation_euler = rot
    if parent is not None:
        obj.parent = parent
    return obj


def bl_box(name, size, loc, mat, bevel=0.0, parent=None, cutters=()):
    def build(bm):
        bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.scale(bm, vec=size, verts=bm.verts)

    obj = bl_object(name, bl_mesh(name, build, [mat], smooth_shade=bevel > 0), loc, parent=parent)
    for cutter in cutters:
        mod = obj.modifiers.new(f"cut_{cutter.name}", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.object = cutter
        mod.solver = "EXACT"
        cutter.hide_render = True
        cutter.display_type = "WIRE"
    if bevel > 0:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 4
        mod.limit_method = "ANGLE"
        mod.harden_normals = True
    return obj


def bl_cylinder(name, radius, depth, loc, rot, mat, segments=48, parent=None, base_origin=False):
    def build(bm):
        bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius, radius2=radius, depth=depth)
        if base_origin:
            bmesh.ops.translate(bm, vec=(0.0, 0.0, depth / 2), verts=bm.verts)

    return bl_object(name, bl_mesh(name, build, [mat], smooth_shade=True), loc, rot, parent)


def bl_torus(name, major, minor, loc, rot, mat, seg=(96, 16), parent=None):
    def build(bm):
        nu, nv = seg
        verts = []
        for i in range(nu):
            a = 2 * math.pi * i / nu
            for j in range(nv):
                b = 2 * math.pi * j / nv
                r = major + minor * math.cos(b)
                verts.append(bm.verts.new((r * math.cos(a), r * math.sin(a), minor * math.sin(b))))
        for i in range(nu):
            for j in range(nv):
                i2, j2 = (i + 1) % nu, (j + 1) % nv
                bm.faces.new((verts[i * nv + j], verts[i2 * nv + j], verts[i2 * nv + j2], verts[i * nv + j2]))

    return bl_object(name, bl_mesh(name, build, [mat], smooth_shade=True), loc, rot, parent)


def bl_sphere(name, radius, loc, mat, parent=None, subdivisions=3):
    def build(bm):
        bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=radius)

    return bl_object(name, bl_mesh(name, build, [mat], smooth_shade=True), loc, parent=parent)


def bl_text(name, body, font, size, loc, rot, mat, parent=None, extrude=0.004, spacing=1.0):
    curve = bpy.data.curves.new(name, "FONT")
    curve.body = body
    curve.font = font
    curve.size = size
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.extrude = extrude
    curve.space_character = spacing
    curve.materials.append(mat)
    return bl_object(name, curve, loc, rot, parent)


def capsule_mesh(name, length, radius, mat):
    def build(bm):
        bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=25, radius=radius)
        half = length / 2 - radius
        for v in bm.verts:
            v.co.z += half if v.co.z > 0 else -half
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0.0, 0.0, 0.0), matrix=Matrix.Rotation(math.pi / 2, 3, "Y"))

    return bl_mesh(name, build, [mat], smooth_shade=True)


def rot_to(direction):
    return Vector((0.0, 0.0, 1.0)).rotation_difference(Vector(direction).normalized()).to_euler()


class NodeMat:
    def __init__(self, name):
        self.mat = bpy.data.materials.new(name)
        self.mat.use_nodes = True
        self.nodes = self.mat.node_tree.nodes
        self.links = self.mat.node_tree.links
        self.nodes.clear()
        self.output = self.nodes.new("ShaderNodeOutputMaterial")

    def add(self, kind, name=None, values=None):
        node = self.nodes.new(kind)
        if name:
            node.name = name
        for key, value in (values or {}).items():
            socket = node.inputs.get(key)
            if socket is not None:
                socket.default_value = value
        return node

    def value(self, name, v):
        node = self.add("ShaderNodeValue", name)
        node.outputs[0].default_value = v
        return node.outputs[0]

    def rgb(self, name, color):
        node = self.add("ShaderNodeRGB", name)
        node.outputs[0].default_value = (*color, 1.0)
        return node.outputs[0]

    def op(self, operation, *args):
        node = self.nodes.new("ShaderNodeMath")
        node.operation = operation
        for i, arg in enumerate(args):
            if isinstance(arg, (int, float)):
                node.inputs[i].default_value = arg
            else:
                self.links.new(arg, node.inputs[i])
        return node.outputs[0]

    def link(self, a, b):
        self.links.new(a, b)

    def done(self, shader_socket):
        self.links.new(shader_socket, self.output.inputs["Surface"])
        return self.mat


def mat_principled(name, values):
    m = NodeMat(name)
    return m.done(m.add("ShaderNodeBsdfPrincipled", "P", values).outputs[0])


def mat_emit(name, color, strength):
    m = NodeMat(name)
    return m.done(m.add("ShaderNodeEmission", "E", {"Color": (*color, 1.0), "Strength": strength}).outputs[0])


def x_mask(m, keep_left):
    geo = m.add("ShaderNodeNewGeometry")
    sep = m.add("ShaderNodeSeparateXYZ")
    m.link(geo.outputs["Position"], sep.inputs[0])
    return m.op("LESS_THAN" if keep_left else "GREATER_THAN", sep.outputs[0], GATE_X)


def masked(m, shader_socket, keep_left):
    mixer = m.add("ShaderNodeMixShader")
    m.link(x_mask(m, keep_left), mixer.inputs[0])
    m.link(m.add("ShaderNodeBsdfTransparent").outputs[0], mixer.inputs[1])
    m.link(shader_socket, mixer.inputs[2])
    return mixer.outputs[0]


def mat_masked_emit(name, color, strength, keep_left):
    m = NodeMat(name)
    emit = m.add("ShaderNodeEmission", "E", {"Color": (*color, 1.0), "Strength": strength})
    return m.done(masked(m, emit.outputs[0], keep_left))


def mat_masked_ink(name, keep_left):
    m = NodeMat(name)
    ink = m.add("ShaderNodeBsdfPrincipled", "P", {"Base Color": (0.008, 0.008, 0.01, 1.0), "Roughness": 0.6})
    return m.done(masked(m, ink.outputs[0], keep_left))


def mat_frost():
    m = NodeMat("frost")
    glass = m.add("ShaderNodeBsdfPrincipled", "P", {"Base Color": (0.95, 0.97, 1.0, 1.0), "Transmission Weight": 1.0,
                                                     "Roughness": 0.5, "IOR": 1.45, "Coat Weight": 0.5, "Coat Roughness": 0.15})
    haze = m.add("ShaderNodeBsdfTranslucent", None, {"Color": (1.0, 0.92, 0.8, 1.0)})
    blend = m.add("ShaderNodeMixShader")
    blend.inputs[0].default_value = 0.6
    m.link(glass.outputs[0], blend.inputs[1])
    m.link(haze.outputs[0], blend.inputs[2])
    glow = m.add("ShaderNodeEmission", None, {"Color": (1.0, 0.72, 0.3, 1.0), "Strength": 0.5})
    total = m.add("ShaderNodeAddShader")
    m.link(blend.outputs[0], total.inputs[0])
    m.link(glow.outputs[0], total.inputs[1])
    return m.done(masked(m, total.outputs[0], True))


def mat_lamp(name, color, strength):
    m = NodeMat(name)
    shell = m.add("ShaderNodeBsdfPrincipled", "P", {"Base Color": (0.85, 0.9, 1.0, 1.0), "Roughness": 0.35,
                                                     "Coat Weight": 1.0, "Coat Roughness": 0.05})
    emit = m.add("ShaderNodeEmission", "E", {"Color": (*color, 1.0), "Strength": strength})
    total = m.add("ShaderNodeAddShader")
    m.link(shell.outputs[0], total.inputs[0])
    m.link(emit.outputs[0], total.inputs[1])
    return m.done(total.outputs[0])


def mat_capsule(name, color):
    m = NodeMat(name)
    tint = m.rgb("C", color)
    strength = m.value("S", 3.2)
    facing = m.add("ShaderNodeLayerWeight", None, {"Blend": 0.3}).outputs["Facing"]
    glow = m.op("MULTIPLY", m.op("MULTIPLY_ADD", m.op("POWER", facing, 1.6), 0.75, 0.25), strength)
    p = m.add("ShaderNodeBsdfPrincipled", "P", {"Base Color": (*(c * 0.06 for c in color), 1.0), "Roughness": 0.1,
                                                 "Coat Weight": 1.0, "Coat Roughness": 0.03})
    m.link(tint, p.inputs["Emission Color"])
    m.link(glow, p.inputs["Emission Strength"])
    return m.done(p.outputs[0])


def mat_membrane():
    m = NodeMat("membrane")
    tint = m.rgb("C", RGB["emerald"])
    fac = m.value("F", 0.0)
    wave = m.add("ShaderNodeTexWave", None, {"Scale": 6.0, "Distortion": 0.0})
    wave.bands_direction = "Z"
    emit = m.add("ShaderNodeEmission")
    m.link(tint, emit.inputs["Color"])
    m.link(m.op("MULTIPLY_ADD", wave.outputs["Fac"], 0.5, 1.0), emit.inputs["Strength"])
    mixer = m.add("ShaderNodeMixShader")
    m.link(fac, mixer.inputs[0])
    m.link(m.add("ShaderNodeBsdfTransparent").outputs[0], mixer.inputs[1])
    m.link(emit.outputs[0], mixer.inputs[2])
    return m.done(mixer.outputs[0])


def mat_debris(name, hot, warm, peak, base=(0.02, 0.01, 0.01), rough=0.25):
    m = NodeMat(name)
    info = m.add("ShaderNodeObjectInfo")
    ramp = m.add("ShaderNodeValToRGB")
    elements = ramp.color_ramp.elements
    elements[0].position, elements[0].color = 0.0, (0.06, 0.004, 0.0, 1.0)
    elements[1].position, elements[1].color = 1.0, (*hot, 1.0)
    middle = elements.new(0.4)
    middle.color = (*warm, 1.0)
    m.link(info.outputs["Alpha"], ramp.inputs["Fac"])
    p = m.add("ShaderNodeBsdfPrincipled", "P", {"Base Color": (*base, 1.0), "Roughness": rough, "Metallic": 0.3})
    m.link(ramp.outputs["Color"], p.inputs["Emission Color"])
    m.link(m.op("MULTIPLY", m.op("POWER", info.outputs["Alpha"], 2.0), peak), p.inputs["Emission Strength"])
    return m.done(p.outputs[0])


def mat_chip():
    m = NodeMat("chip")
    brick = m.add("ShaderNodeTexBrick", None, {"Scale": 9.0, "Mortar Size": 0.035})
    strength = m.op("MULTIPLY", brick.outputs["Fac"], m.value("S", 1.5))
    p = m.add("ShaderNodeBsdfPrincipled", "P", {"Base Color": (0.02, 0.02, 0.022, 1.0), "Metallic": 0.85, "Roughness": 0.28,
                                                 "Emission Color": (*RGB["amber"], 1.0)})
    m.link(strength, p.inputs["Emission Strength"])
    return m.done(p.outputs[0])


def mat_streaked(name, base, metallic, rough_lo, rough_hi, stretch, specular=0.45):
    m = NodeMat(name)
    coords = m.add("ShaderNodeTexCoord")
    mapping = m.add("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = stretch
    m.link(coords.outputs["Object"], mapping.inputs["Vector"])
    noise = m.add("ShaderNodeTexNoise", None, {"Scale": 2.0, "Detail": 3.0})
    m.link(mapping.outputs["Vector"], noise.inputs["Vector"])
    p = m.add("ShaderNodeBsdfPrincipled", "P", {"Base Color": (*base, 1.0), "Metallic": metallic, "Specular IOR Level": specular})
    m.link(m.op("MULTIPLY_ADD", noise.outputs["Fac"], rough_hi - rough_lo, rough_lo), p.inputs["Roughness"])
    return m.done(p.outputs[0])


def build_materials():
    return {
        "anodized": mat_principled("anodized", {"Base Color": (0.03, 0.032, 0.036, 1.0), "Metallic": 0.92, "Roughness": 0.22}),
        "floor": mat_streaked("floor", (0.006, 0.0064, 0.0075), 0.0, 0.16, 0.3, (0.08, 0.08, 0.08), specular=0.28),
        "steel": mat_streaked("steel", (0.62, 0.64, 0.68), 1.0, 0.1, 0.24, (0.25, 30.0, 30.0)),
        "trackline": mat_emit("trackline", RGB["ice"], 1.4),
        "label": mat_emit("label", (0.95, 0.97, 1.0), 5.5),
        "label_dim": mat_emit("label_dim", RGB["ice"], 1.6),
        "label_gate": mat_emit("label_gate", (1.0, 1.0, 1.0), 4.0),
        "env_label": mat_masked_emit("env_label", (1.0, 0.86, 0.55), 6.0, False),
        "redacted_label": mat_masked_ink("redacted_label", True),
        "frost": mat_frost(),
        "glass": mat_principled("glass", {"Base Color": (1.0, 1.0, 1.0, 1.0), "Transmission Weight": 1.0, "Roughness": 0.03,
                                          "IOR": 1.52, "Thin Film Thickness": 320.0, "Thin Film IOR": 1.35}),
        "shield": mat_principled("shield", {"Base Color": (0.95, 0.98, 1.0, 1.0), "Transmission Weight": 1.0, "Roughness": 0.02,
                                            "IOR": 1.52, "Thin Film Thickness": 520.0, "Thin Film IOR": 1.4}),
        "shield_edge": mat_emit("shield_edge", (0.75, 0.9, 1.0), 9.0),
        "membrane": mat_membrane(),
        "strip": mat_emit("strip", RGB["emerald"], 0.0),
        "ring": mat_emit("ring", RGB["emerald"], 0.0),
        "muzzle": mat_emit("muzzle", RGB["ice"], 0.8),
        "port": mat_emit("port", RGB["ice"], 1.6),
        "core": mat_lamp("core", (0.75, 0.88, 1.0), 1.6),
        "laser_hit": mat_emit("laser_hit", (1.0, 0.25, 0.18), 0.0),
        "chip": mat_chip(),
        "s1_glow": mat_emit("s1_glow", RGB["amber"], 2.0),
        "laser": mat_emit("laser", (1.0, 0.04, 0.03), 0.0),
        "laser_cut": mat_emit("laser_cut", (1.0, 0.04, 0.03), 0.0),
        "s1_beam": mat_emit("s1_beam", (1.0, 0.55, 0.12), 0.0),
        "lock": mat_emit("lock", RGB["amber"], 0.0),
        "loop": mat_emit("loop", RGB["crimson"], 0.0),
        "counter": mat_emit("counter", (1.0, 0.18, 0.12), 0.0),
        "shard": mat_debris("shard", (1.0, 0.05, 0.02), (0.45, 0.008, 0.004), 4.0, base=(0.08, 0.004, 0.004), rough=0.08),
        "spark": mat_debris("spark", (1.0, 0.8, 0.45), (1.0, 0.3, 0.05), 25.0),
    }


def build_cyclorama(mat):
    profile = [(-45.0, 0.0), (-20.0, 0.0), (0.0, 0.0), (6.0, 0.0), (12.0, 0.0)]
    for k in range(1, 17):
        a = -math.pi / 2 + (math.pi / 2) * k / 16
        profile.append((12.0 + 9.0 * math.cos(a), 9.0 + 9.0 * math.sin(a)))
    profile.append((21.0, 30.0))

    def build(bm):
        rows = [(bm.verts.new((-70.0, y, z)), bm.verts.new((70.0, y, z))) for y, z in profile]
        for (a0, a1), (b0, b1) in zip(rows, rows[1:]):
            bm.faces.new((a0, a1, b1, b0))

    return bl_object("cyclorama", bl_mesh("cyclorama", build, [mat], smooth_shade=True))


def build_capsule(spec, fonts, mats):
    name, length, radius = spec["name"], spec["length"], spec["radius"]
    mat = mat_capsule(f"cap_{name}", RGB[spec["color"]])
    body = bl_object(f"cap_{name}", capsule_mesh(f"cap_{name}", length, radius, mat))
    size = min(0.23, (length - 1.6 * radius) / (0.6 * max(len(spec["label"]), 1)))
    if spec["top_label"]:
        where, rot = (0.0, 0.0, radius + 0.004), (0.0, 0.0, 0.0)
    else:
        where, rot = (0.0, -(radius + 0.004), 0.0), FACE_NY
    label_mat = mats["env_label"] if spec["masked"] else mats["label"]
    bl_text(f"label_{name}", spec["label"], fonts["mono"], size, where, rot, label_mat, parent=body)
    if spec["masked"]:
        shell = bl_object(f"shell_{name}", capsule_mesh(f"shell_{name}", length + 0.08, radius + 0.04, mats["frost"]), parent=body)
        shell.location = (0.0, 0.0, 0.0)
        bl_text(f"redacted_{name}", "[redacted]", fonts["mono"], 0.19, (0.0, -(radius + 0.046), 0.0), FACE_NY,
                mats["redacted_label"], parent=body)
    return body, mat


class Debris:
    def __init__(self, name, count, sizes, mat, seed, kind):
        self.rng = random.Random(seed)
        self.objs = []
        self.bursts = []
        meshes = [self._mesh(f"{name}_mesh{i}", mat, kind) for i in range(6)]
        for i in range(count):
            obj = bl_object(f"{name}{i}", meshes[i % len(meshes)])
            s = self.rng.uniform(*sizes)
            obj.scale = (s, s, s)
            obj.color = (1.0, 1.0, 1.0, 0.0)
            obj.hide_render = True
            self.objs.append(obj)

    def _mesh(self, name, mat, kind):
        rng = self.rng

        def build(bm):
            bmesh.ops.create_icosphere(bm, subdivisions=0 if kind == "shard" else 1, radius=1.0)
            stretch = (rng.uniform(0.6, 1.3), rng.uniform(0.25, 0.7), rng.uniform(0.6, 1.4)) if kind == "shard" else (1, 1, 1)
            for v in bm.verts:
                jitter = rng.uniform(0.7, 1.3) if kind == "shard" else 1.0
                v.co.x *= stretch[0] * jitter
                v.co.y *= stretch[1] * jitter
                v.co.z *= stretch[2] * jitter

        return bl_mesh(name, build, [mat], smooth_shade=kind != "shard")

    def burst(self, t0, origin, extent, vel_lo, vel_hi, life, share=1.0):
        self.bursts.append(dict(t0=t0, origin=origin, extent=extent, vel_lo=vel_lo, vel_hi=vel_hi, life=life, share=share))

    @staticmethod
    def ground(x, y):
        if RAIL_X[0] <= x <= RAIL_X[1]:
            if abs(y) <= 0.07:
                return RAIL_TOP
            if abs(y) <= 0.32:
                return PLINTH_TOP
        return 0.0

    def bake(self):
        rng = self.rng
        for obj in self.objs:
            loc_keys, rot_keys, alpha_keys, vis_keys = [[], [], []], [[], [], []], [], []
            size = obj.scale[0]
            for b in self.bursts:
                if rng.random() > b["share"]:
                    continue
                life = b["life"] * rng.uniform(0.55, 1.0)
                p = [b["origin"][i] + rng.uniform(-b["extent"][i], b["extent"][i]) for i in range(3)]
                v = [rng.uniform(b["vel_lo"][i], b["vel_hi"][i]) for i in range(3)]
                v[1] += rng.gauss(0.0, 0.25 * max(abs(b["vel_hi"][1]), 0.5))
                rot0 = [rng.uniform(0, 2 * math.pi) for _ in range(3)]
                spin = [rng.uniform(-14, 14) for _ in range(3)]
                f_start = math.ceil(b["t0"] * FPS)
                f_end = math.ceil((b["t0"] + life) * FPS)
                vis_keys.append((f_start, 0.0))
                vis_keys.append((f_end, 1.0))
                for i in range(3):
                    loc_keys[i].append((f_start - 0.5, p[i]))
                t_prev = b["t0"]
                for f in range(f_start, f_end + 1):
                    t = f / FPS
                    steps = 4
                    dt = (t - t_prev) / steps
                    for _ in range(steps):
                        v[2] -= 9.81 * dt
                        for i in range(3):
                            v[i] *= 1.0 - 0.5 * dt
                            p[i] += v[i] * dt
                        floor = self.ground(p[0], p[1]) + size * 0.5
                        if p[2] < floor:
                            p[2] = floor
                            v[2] = -v[2] * 0.3
                            v[0] *= 0.6
                            v[1] *= 0.6
                    t_prev = t
                    age = t - b["t0"]
                    for i in range(3):
                        loc_keys[i].append((f, p[i]))
                        rot_keys[i].append((f, rot0[i] + spin[i] * age))
                    alpha_keys.append((f, (1.0 - age / life) ** 1.4 if age < life else 0.0))
            if not vis_keys:
                continue
            for i in range(3):
                bake(obj, "location", loc_keys[i], i)
                bake(obj, "rotation_euler", rot_keys[i], i)
            bake(obj, "color", alpha_keys, 3)
            bake(obj, "hide_render", [(-1, 1.0)] + vis_keys, -1, "CONSTANT")


def bl_fcurve(idb, path, index):
    want = max(index, 0)
    anim = idb.animation_data
    action = anim.action
    pools = []
    slot = getattr(anim, "action_slot", None)
    if slot is not None and getattr(action, "layers", None):
        for layer in action.layers:
            for strip in layer.strips:
                bag = strip.channelbag(slot)
                if bag is not None:
                    pools.append(bag.fcurves)
    else:
        pools.append(action.fcurves)
    for fcurves in pools:
        for fc in fcurves:
            if fc.data_path == path and fc.array_index == want:
                return fc
    raise LookupError(f"{idb.name}: no fcurve {path}[{want}]")


def thin(keys):
    if len(keys) < 3:
        return keys
    out = [keys[0]]
    for prev, cur, nxt in zip(keys, keys[1:], keys[2:]):
        if not (prev[1] == cur[1] == nxt[1]):
            out.append(cur)
    out.append(keys[-1])
    return out


def bake(idb, path, keys, index=-1, interp="LINEAR"):
    keys = thin(sorted(keys))
    idb.keyframe_insert(data_path=path, index=index, frame=keys[0][0])
    fc = bl_fcurve(idb, path, index)
    points = fc.keyframe_points
    if len(points) != 1:
        raise RuntimeError(f"{idb.name}: {path}[{index}] is animated twice")
    points[0].co = keys[0]
    points[0].interpolation = interp
    if len(keys) > 1:
        points.add(len(keys) - 1)
        for point, key in zip(list(points)[1:], keys[1:]):
            point.co = key
            point.interpolation = interp
    fc.update()


def bake_fn(idb, path, fn, frames, size=None, interp="LINEAR"):
    values = [fn(f / FPS) for f in frames]
    if size is None:
        bake(idb, path, [(f, float(v)) for f, v in zip(frames, values)], -1, interp)
    else:
        for i in range(size):
            bake(idb, path, [(f, float(v[i])) for f, v in zip(frames, values)], i, interp)


def bake_visible(obj, visible, frames, skip=()):
    keys, prev = [], None
    for f in frames:
        v = 0.0 if visible(f / FPS) else 1.0
        if v != prev:
            keys.append((f, v))
            prev = v
    skipped = set()
    for root in skip:
        skipped.update([root, *root.children_recursive])
    for o in [obj, *obj.children_recursive]:
        if o not in skipped:
            bake(o, "hide_render", keys, -1, "CONSTANT")


def node_path(node, socket="inputs", index=0):
    return f'nodes["{node}"].{socket}[{index}].default_value'


def frames_between(t0, t1, pad=2):
    return list(range(max(-2, math.floor(t0 * FPS) - pad), min(FRAME_COUNT + 2, math.ceil(t1 * FPS) + pad) + 1))


ALL_FRAMES = frames_between(0.0, DURATION)


def bl_setup(samples, scale, device):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    chosen = "CPU"
    for kind in (device, "OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
        except TypeError:
            continue
        getattr(prefs, "refresh_devices", prefs.get_devices)()
        if any(d.type == kind for d in prefs.devices):
            for d in prefs.devices:
                d.use = d.type == kind
            chosen = kind
            break
    scene.cycles.device = "GPU" if chosen != "CPU" else "CPU"
    scene.render.resolution_x, scene.render.resolution_y = WIDTH, HEIGHT
    scene.render.resolution_percentage = scale
    scene.render.fps = FPS
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.03
    scene.cycles.adaptive_min_samples = min(16, samples)
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.cycles.denoising_use_gpu = chosen != "CPU"
    scene.cycles.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    scene.cycles.denoising_prefilter = "FAST"
    scene.cycles.max_bounces = 6
    scene.cycles.diffuse_bounces = 1
    scene.cycles.glossy_bounces = 2
    scene.cycles.transmission_bounces = 4
    scene.cycles.transparent_max_bounces = 6
    scene.cycles.volume_bounces = 0
    scene.cycles.caustics_reflective = False
    scene.cycles.caustics_refractive = False
    scene.cycles.blur_glossy = 0.8
    scene.cycles.sample_clamp_indirect = 4.0
    scene.render.use_motion_blur = True
    scene.render.motion_blur_shutter = 0.5
    scene.render.use_persistent_data = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 15
    scene.render.use_overwrite = False
    scene.render.use_placeholder = True
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Punchy"
    scene.frame_start, scene.frame_end = 0, FRAME_COUNT - 1
    world = bpy.data.worlds.new("void")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs[0].default_value = (0.0016, 0.0018, 0.0024, 1.0)
    background.inputs[1].default_value = 1.0
    scene.world = world
    return scene, chosen


def area_light(name, size, loc, target, energy, color, spread=None):
    data = bpy.data.lights.new(name, "AREA")
    data.shape = "RECTANGLE"
    data.size, data.size_y = size
    data.energy = energy
    data.color = color
    if spread:
        data.spread = math.radians(spread)
    obj = bl_object(name, data, loc)
    obj.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    obj.visible_camera = False
    return obj


def point_light(name, loc, color, radius=0.2):
    data = bpy.data.lights.new(name, "POINT")
    data.energy = 0.0
    data.color = color
    data.shadow_soft_size = radius
    return bl_object(name, data, loc)


def build_scene(fonts):
    mats = build_materials()
    rig = {"mats": mats}
    build_cyclorama(mats["floor"])
    length, center = RAIL_X[1] - RAIL_X[0], (RAIL_X[0] + RAIL_X[1]) / 2
    bl_box("plinth", (length, 0.64, PLINTH_TOP), (center, 0.0, PLINTH_TOP / 2), mats["anodized"], bevel=0.015)
    bl_box("rail", (length, 0.14, RAIL_TOP - PLINTH_TOP), (center, 0.0, (RAIL_TOP + PLINTH_TOP) / 2), mats["steel"], bevel=0.01)
    for side in (-1, 1):
        bl_box(f"trackline{side}", (length, 0.012, 0.012), (center, side * 0.326, PLINTH_TOP + 0.002), mats["trackline"])

    launcher = bl_object("launcher_root", None, (-11.2, 0.0, 0.0))
    bore = bl_cylinder("launcher_bore", 0.34, 2.4, (0.6, 0.0, CAP_Z), (0.0, math.pi / 2, 0.0), mats["anodized"], parent=launcher)
    bl_box("launcher", (2.4, 2.0, 2.1), (0.0, 0.0, 1.05), mats["anodized"], bevel=0.06, parent=launcher, cutters=[bore])
    bl_torus("muzzle_collar", 0.44, 0.07, (1.21, 0.0, CAP_Z), (0.0, math.pi / 2, 0.0), mats["anodized"], parent=launcher)
    bl_torus("muzzle_ring", 0.36, 0.022, (1.26, 0.0, CAP_Z), (0.0, math.pi / 2, 0.0), mats["muzzle"], parent=launcher)
    bl_text("agent_label", "AI AGENT", fonts["mono"], 0.24, (0.0, -1.006, 1.62), FACE_NY, mats["label_dim"], parent=launcher,
            spacing=1.15)
    bl_box("agent_slit", (1.7, 0.01, 0.022), (0.0, -1.004, 1.36), mats["trackline"], parent=launcher)
    rig["launcher"] = launcher

    port_bore = bl_cylinder("port_bore", 0.36, 2.5, (7.75, 0.0, CAP_Z), (0.0, math.pi / 2, 0.0), mats["anodized"])
    bl_box("machine", (2.8, 2.4, 2.6), (8.4, 0.0, 1.3), mats["anodized"], bevel=0.06, cutters=[port_bore])
    bl_torus("port_collar", 0.47, 0.06, (PORT_X - 0.01, 0.0, CAP_Z), (0.0, math.pi / 2, 0.0), mats["anodized"])
    bl_torus("port_ring", 0.42, 0.022, (PORT_X - 0.06, 0.0, CAP_Z), (0.0, math.pi / 2, 0.0), mats["port"])
    bl_box("core", (1.0, 1.0, 1.0), (8.4, 0.0, 3.12), mats["core"], bevel=0.04)
    bl_text("machine_label", "YOUR MACHINE", fonts["mono"], 0.2, (8.4, -1.206, 1.95), FACE_NY, mats["label_dim"], spacing=1.15)
    bl_box("machine_slit", (2.2, 0.01, 0.022), (8.4, -1.204, 1.7), mats["trackline"])

    gate = bl_object("gate_root", None, (GATE_X, 0.0, 0.0))
    for side in (-1, 1):
        bl_box(f"pillar{side}", (0.42, 0.42, 3.4), (0.0, side * 0.95, 1.7), mats["anodized"], bevel=0.02, parent=gate)
        bl_box(f"strip{side}", (0.05, 0.02, 2.78), (0.0, side * 0.73, RAIL_TOP + 1.39), mats["strip"], parent=gate)
        bl_box(f"edge{side}", (0.012, 0.03, 3.3), (-0.216, side * 0.79, 1.7), mats["strip"], parent=gate)
    bl_box("beam", (0.46, 2.32, 0.5), (0.0, 0.0, 3.65), mats["anodized"], bevel=0.02, parent=gate)
    bl_box("strip_top", (0.05, 1.48, 0.02), (0.0, 0.0, 3.39), mats["strip"], parent=gate)
    bl_box("membrane", (0.02, 1.44, 2.76), (0.0, 0.0, RAIL_TOP + 1.39), mats["membrane"], parent=gate)
    bl_text("gate_label", "pi-warden", fonts["black"], 0.34, (-0.236, 0.0, 3.66), FACE_NX, mats["label_gate"], parent=gate)
    shield = bl_object("shield_root", None, (SHIELD_X - GATE_X, 0.0, 0.0), parent=gate)
    bl_box("shield", (0.03, 1.44, 2.76), (0.0, 0.0, RAIL_TOP + 1.39), mats["shield"], parent=shield)
    for z in (RAIL_TOP + 0.01, RAIL_TOP + 2.77):
        bl_box(f"shield_h{z:.2f}", (0.04, 1.44, 0.02), (0.0, 0.0, z), mats["shield_edge"], parent=shield)
    for side in (-1, 1):
        bl_box(f"shield_v{side}", (0.04, 0.02, 2.76), (0.0, side * 0.71, RAIL_TOP + 1.39), mats["shield_edge"], parent=shield)
    rig["gate"], rig["shield"] = gate, shield
    rig["wave"] = bl_torus("pass_ring", 0.5, 0.02, (0.0, 0.0, CAP_Z), (0.0, math.pi / 2, 0.0), mats["ring"], parent=gate)

    s1 = bl_object("s1_root", None, S1_POS)
    bl_box("s1_chip", (0.9, 0.9, 0.14), (0.0, 0.0, 0.0), mats["chip"], bevel=0.02, parent=s1)
    bl_torus("s1_halo", 0.72, 0.012, (0.0, 0.0, 0.0), (0.0, 0.0, 0.0), mats["s1_glow"], parent=s1)
    bl_text("s1_label", "WARDEN-S1", fonts["mono"], 0.12, (0.0, -0.455, 0.0), FACE_NY, mats["label"], parent=s1, spacing=1.1)
    rig["s1"] = s1

    rig["laser"] = bl_cylinder("laser", 0.05, 1.0, LASER_FROM, rot_to(LASER_DIR), mats["laser"], 12, base_origin=True)
    cut_point = tuple(a + CUT_LEN * d for a, d in zip(LASER_FROM, LASER_DIR))
    rig["laser_cut"] = bl_cylinder("laser_cut", 0.05, 1.0, cut_point, rot_to(LASER_DIR), mats["laser_cut"], 12, base_origin=True)
    rig["laser_hit"] = bl_sphere("laser_hit", 0.12, cut_point, mats["laser_hit"], subdivisions=2)
    s1_from = (S1_POS[0], 0.0, S1_POS[2] - 0.07)
    s1_to = (TURN_STOP_X, 0.0, CAP_Z + CAP_R + 0.02)
    s1_dir = tuple(b - a for a, b in zip(s1_from, s1_to))
    rig["s1_beam_len"] = math.dist(s1_from, s1_to)
    rig["s1_beam"] = bl_cylinder("s1_beam", 0.012, 1.0, s1_from, rot_to(s1_dir), mats["s1_beam"], 12, base_origin=True)
    rig["s1_dot"] = bl_sphere("s1_dot", 0.05, s1_to, mats["s1_beam"], subdivisions=2)
    rig["lock"] = bl_torus("lock_ring", 0.42, 0.012, (TURN_STOP_X, 0.0, CAP_Z), (0.0, math.pi / 2, 0.0), mats["lock"])

    loop_root = bl_object("loop_root", None, (LOOP_C[0], LOOP_C[1], 0.0))
    bl_torus("loop_track", LOOP_R, 0.07, (0.0, 0.0, 0.6), (0.0, 0.0, 0.0), mats["anodized"], seg=(128, 12), parent=loop_root)
    bl_torus("loop_ring", LOOP_R, 0.028, (0.0, 0.0, 0.69), (0.0, 0.0, 0.0), mats["loop"], seg=(128, 12), parent=loop_root)
    rig["counters"] = [bl_text(f"count{n}", f"×{n}", fonts["black"], 0.95, (0.0, 0.0, 0.7), (0.0, 0.0, 0.0), mats["counter"],
                               parent=loop_root, extrude=0.012) for n in range(1, 5)]
    bl_box("switch_base", (0.34, 0.3, 0.12), (0.0, LOOP_R - 0.5, 0.66), mats["anodized"], bevel=0.01, parent=loop_root)
    hinge = bl_object("switch_hinge", None, (-0.16, LOOP_R - 0.44, 0.75), parent=loop_root)
    bl_box("switch_arm", (0.64, 0.06, 0.05), (0.32, 0.0, 0.0), mats["anodized"], bevel=0.008, parent=hinge)
    bl_box("switch_tip", (0.06, 0.07, 0.06), (0.64, 0.0, 0.0), mats["counter"], parent=hinge)
    rig["loop"], rig["hinge"] = loop_root, hinge

    rig["capsules"] = [(spec, *build_capsule(spec, fonts, mats)) for spec in SPECS]
    rig["shards"] = Debris("shard", 70, (0.02, 0.06), mats["shard"], 11, "shard")
    rig["shards_b"] = Debris("shardb", 40, (0.02, 0.05), mats["shard"], 12, "shard")
    rig["sparks"] = Debris("spark", 70, (0.008, 0.018), mats["spark"], 13, "spark")

    rig["key"] = area_light("key", (7.0, 3.5), (-4.0, -1.8, 9.0), (-4.0, 0.0, 0.0), 1700.0, (0.93, 0.96, 1.0), spread=60)
    rig["key_b"] = area_light("key_b", (7.0, 3.5), (5.6, -1.8, 9.0), (5.6, 0.0, 0.0), 2100.0, (0.93, 0.96, 1.0), spread=60)
    rig["rim_l"] = area_light("rim_l", (6.0, 3.0), (-7.0, 7.5, 4.5), (-4.0, 0.0, 1.0), 1100.0, (1.0, 0.62, 0.32))
    rig["rim_r"] = area_light("rim_r", (6.0, 3.0), (10.0, 7.5, 4.5), (6.0, 0.0, 1.2), 1100.0, RGB["ice"])
    rig["fill"] = area_light("fill", (12.0, 5.0), (0.0, -16.0, 5.0), (0.0, 0.0, 1.0), 260.0, (0.75, 0.82, 1.0))
    rig["wall"] = area_light("wall", (16.0, 4.0), (0.0, 12.0, 0.3), (0.0, 22.0, 6.0), 900.0, (0.35, 0.42, 0.55))
    rig["flash"] = point_light("flash", (GATE_X - 0.5, -0.3, 1.2), RGB["crimson"])
    rig["laser_light"] = point_light("laser_light", cut_point, (1.0, 0.05, 0.03), 0.1)
    rig["s1_light"] = point_light("s1_light", (S1_POS[0], 0.0, S1_POS[2] - 0.3), RGB["amber"], 0.15)
    rig["cut_point"] = cut_point
    for mat in bpy.data.materials:
        mat.cycles.emission_sampling = "NONE"
    return rig


# One camera per take, switched by a marker: Cycles blurs each frame with the camera active at its centre. A cut inside
# one camera's curve smeared the frame before it, because FCurve.update() merges keys under 0.01 frames apart.
def build_cameras():
    scene = bpy.context.scene
    rigs = []
    for k, first in enumerate(TAKE_FRAMES[:-1]):
        data = bpy.data.cameras.new(f"camera{k}")
        data.sensor_width = 36.0
        data.clip_start = 0.05
        data.clip_end = 400.0
        data.dof.use_dof = True
        data.dof.aperture_blades = 7
        cam = bl_object(f"camera{k}", data)
        target = bl_object(f"camera_target{k}", None)
        con = cam.constraints.new("TRACK_TO")
        con.target = target
        con.track_axis = "TRACK_NEGATIVE_Z"
        con.up_axis = "UP_Y"
        scene.timeline_markers.new(f"take{k}", frame=first).camera = cam
        rigs.append((cam, target))
    scene.camera = rigs[0][0]
    return rigs


def animate_cameras(rigs):
    for k, ((cam, target), take) in enumerate(zip(rigs, CAM_TAKES)):
        poses = [(f, camera(take, f / FPS)) for f in range(TAKE_FRAMES[k] - 2, TAKE_FRAMES[k + 1] + 2)]
        for i in range(3):
            bake(cam, "location", [(f, p[0][i]) for f, p in poses], i)
            bake(target, "location", [(f, p[1][i]) for f, p in poses], i)
        bake(cam.data, "lens", [(f, p[2]) for f, p in poses])
        bake(cam.data, "dof.aperture_fstop", [(f, p[3]) for f, p in poses])
        bake(cam.data, "dof.focus_distance", [(f, p[4]) for f, p in poses])


def animate_capsules(rig):
    for spec, body, mat in rig["capsules"]:
        frames = frames_between(spec["show"], spec["hide"])
        path = spec["path"]
        bake_fn(body, "location", lambda t: path(t)[:3], frames, 3)
        if spec["top_label"]:
            bake_fn(body, "rotation_euler", lambda t: (0.0, 0.0, path(t)[3]), frames, 3)
        bake_visible(body, lambda t, s=spec: s["show"] <= t < s["hide"], ALL_FRAMES)
        base = RGB[spec["color"]]
        if spec["recolor"]:
            t_re, name = spec["recolor"]
            bake_fn(mat.node_tree, node_path("C", "outputs"), lambda t: mix(base, RGB[name], smooth(span(t, t_re, t_re + 0.2))),
                    frames, 3)
        dim = spec.get("dim")
        if dim or spec["name"] == "turn":
            def strength(t, s=spec):
                k = 3.2
                if s.get("dim"):
                    k *= lerp(1.0, s["dim"][1], smooth(span(t, s["dim"][0], s["dim"][0] + 0.4)))
                if s["name"] == "turn":
                    k *= 1.0 + 1.6 * flash(t, EV["lock"], 0.03, 0.5)
                return k
            bake_fn(mat.node_tree, node_path("S", "outputs"), strength, frames)
        if spec["fade"]:
            f0, f1 = spec["fade"]
            bake_fn(body, "scale", lambda t: (lerp(1.0, 0.02, smooth(span(t, f0, f1))),) * 3, frames, 3)


def animate_stage(rig):
    mats = rig["mats"]
    frames = ALL_FRAMES
    gate = rig["gate"]

    def gate_z(t):
        drop, land = EV["gate_drop"], EV["gate_land"]
        if t < land:
            u = span(t, drop, land)
            return 7.5 * (1.0 - u * u)
        u = t - land
        return 0.05 * math.sin(math.pi * u / 0.09) if u < 0.09 else 0.012 * math.sin(math.pi * (u - 0.09) / 0.07) if u < 0.16 else 0.0

    bake_fn(gate, "location", lambda t: (GATE_X, 0.0, gate_z(t)), frames_between(EV["gate_drop"] - 0.1, EV["gate_land"] + 0.3), 3)
    bake_visible(gate, lambda t: t >= EV["gate_drop"], frames, skip=[rig["shield"]])

    def strip(t):
        return gate_glow(t)

    bake_fn(mats["strip"].node_tree, node_path("E", "inputs", 1), lambda t: strip(t)[0], frames)
    bake_fn(mats["strip"].node_tree, node_path("E", "inputs", 0), lambda t: strip(t)[1], frames, 3)
    bake_fn(mats["membrane"].node_tree, node_path("F", "outputs"), membrane_fac, frames)
    bake_fn(mats["membrane"].node_tree, node_path("C", "outputs"), lambda t: strip(t)[1], frames, 3)
    wave = rig["wave"]
    bake_fn(wave, "scale", lambda t: (ring_wave(t)[0],) * 3, frames, 3)
    bake_fn(mats["ring"].node_tree, node_path("E", "inputs", 1), lambda t: ring_wave(t)[1], frames)
    bake_fn(mats["ring"].node_tree, node_path("E", "inputs", 0), lambda t: ring_wave(t)[2], frames, 3)

    def shield_z(t):
        down = smooth(span(t, EV["shield"], EV["shield"] + 0.07))
        up = smooth(span(t, EV["shield_up"], EV["shield_up"] + 0.2))
        return lerp(2.9, 0.0, down) + 2.9 * up

    bake_fn(rig["shield"], "location", lambda t: (SHIELD_X - GATE_X, 0.0, shield_z(t)), frames_between(EV["shield"] - 0.1, EV["shield_up"] + 0.3), 3)
    bake_visible(rig["shield"], lambda t: EV["shield"] - 0.02 <= t < EV["shield_up"] + 0.2, frames)

    def laser_len(t):
        if t < EV["laser"]:
            return 0.001
        grow = LASER_LEN * ease_out(span(t, EV["laser"], EV["laser"] + 0.06))
        return min(grow, CUT_LEN) if t >= EV["cut"] else grow

    beam_end = EV["fetch_fade"] + 0.05

    def laser_glow(t):
        on = window(t, EV["laser"], beam_end, 0.02, 0.3)
        return 60.0 * on * (1.0 + 0.25 * math.sin(2 * math.pi * 31 * t))

    bake_fn(rig["laser"], "scale", lambda t: (1.0, 1.0, laser_len(t)), frames_between(EV["laser"] - 0.05, beam_end), 3)
    bake_fn(mats["laser"].node_tree, node_path("E", "inputs", 1), laser_glow, frames)
    bake_visible(rig["laser"], lambda t: EV["laser"] <= t < beam_end, frames)
    bake_fn(mats["laser_hit"].node_tree, node_path("E", "inputs", 1),
            lambda t: 50.0 * window(t, EV["cut"], beam_end, 0.01, 0.3) * (1.0 + 0.35 * math.sin(2 * math.pi * 19 * t)), frames)
    bake_visible(rig["laser_hit"], lambda t: EV["cut"] <= t < beam_end, frames)
    severed = lambda t: span(t, EV["cut"], EV["cut"] + 0.22)
    bake_fn(rig["laser_cut"], "location", lambda t: tuple(c + 9.0 * severed(t) * d for c, d in zip(rig["cut_point"], LASER_DIR)),
            frames_between(EV["cut"] - 0.05, EV["cut"] + 0.3), 3)
    bake_fn(rig["laser_cut"], "scale", lambda t: (1.0, 1.0, LASER_LEN - CUT_LEN), frames_between(EV["cut"], EV["cut"] + 0.3), 3)
    bake_fn(mats["laser_cut"].node_tree, node_path("E", "inputs", 1), lambda t: 45.0 * (1.0 - severed(t)) ** 2, frames)
    bake_visible(rig["laser_cut"], lambda t: EV["cut"] <= t < EV["cut"] + 0.22, frames)
    bake_fn(rig["laser_light"].data, "energy", lambda t: 260.0 * window(t, EV["laser"], beam_end, 0.02, 0.3)
            * (1.0 + 0.3 * math.sin(2 * math.pi * 23 * t)) + 900.0 * flash(t, EV["cut"], 0.01, 0.12), frames)

    s1 = rig["s1"]
    bake_fn(s1, "location", lambda t: (S1_POS[0], 0.0, S1_POS[2] + 0.05 * math.sin(2 * math.pi * 0.45 * t)), frames, 3)
    bake_fn(s1, "rotation_euler", lambda t: (0.0, 0.0, 0.08 * math.sin(2 * math.pi * 0.3 * t)), frames, 3)
    bake_fn(s1, "scale", lambda t: (smooth(span(t, EV["gate_land"] + 0.2, EV["gate_land"] + 0.6)),) * 3,
            frames_between(EV["gate_land"], EV["gate_land"] + 0.7), 3)
    bake_visible(s1, lambda t: t >= EV["gate_land"] + 0.2, frames)
    s1_level = lambda t: 1.2 + 9.0 * flash(t, EV["s1_pulse"], 0.04, 0.5) + 3.0 * window(t, EV["s1_beam"], EV["turn_fade"], 0.1, 0.3)
    bake_fn(mats["chip"].node_tree, node_path("S", "outputs"), s1_level, frames)
    bake_fn(mats["s1_glow"].node_tree, node_path("E", "inputs", 1), lambda t: 1.5 * s1_level(t), frames)
    bake_fn(rig["s1_light"].data, "energy", lambda t: 25.0 * s1_level(t), frames)
    beam_on = lambda t: ease_out(span(t, EV["s1_beam"], EV["s1_beam"] + 0.14))
    bake_fn(rig["s1_beam"], "scale", lambda t: (1.0, 1.0, max(0.001, rig["s1_beam_len"] * beam_on(t))),
            frames_between(EV["s1_beam"] - 0.05, EV["s1_beam"] + 0.2), 3)
    bake_fn(mats["s1_beam"].node_tree, node_path("E", "inputs", 1),
            lambda t: 28.0 * window(t, EV["s1_beam"], EV["turn_fade"] + 0.2, 0.05, 0.3), frames)
    bake_visible(rig["s1_beam"], lambda t: EV["s1_beam"] <= t < EV["turn_fade"] + 0.2, frames)
    bake_visible(rig["s1_dot"], lambda t: EV["s1_beam"] + 0.12 <= t < EV["turn_fade"] + 0.2, frames)
    lock = rig["lock"]
    bake_fn(lock, "scale", lambda t: (lerp(2.2, 1.0, ease_out(span(t, EV["lock"], EV["lock"] + 0.25))),) * 3,
            frames_between(EV["lock"] - 0.05, EV["lock"] + 0.3), 3)
    bake_fn(mats["lock"].node_tree, node_path("E", "inputs", 1), lambda t: 12.0 * window(t, EV["lock"], EV["turn_fade"] + 0.1, 0.08, 0.3),
            frames)
    bake_visible(lock, lambda t: EV["lock"] <= t < EV["turn_fade"] + 0.1, frames)

    loop_on = lambda t: window(t, EV["loop_start"] - 0.1, LOOP_PASSES[3] + 0.6, 0.05, 0.45)
    bake_visible(rig["loop"], lambda t: EV["loop_start"] - 0.1 <= t < LOOP_PASSES[3] + 0.6, frames, skip=rig["counters"])
    bake_fn(mats["loop"].node_tree, node_path("E", "inputs", 1),
            lambda t: loop_on(t) * (5.0 + 3.0 * sum(flash(t, p, 0.01, 0.18) for p in LOOP_PASSES[:3])), frames)
    bake_fn(mats["loop"].node_tree, node_path("E", "inputs", 0),
            lambda t: mix(RGB["crimson"], (0.25, 0.27, 0.3), smooth(span(t, LOOP_PASSES[3], LOOP_PASSES[3] + 0.3))), frames, 3)
    bake_fn(mats["counter"].node_tree, node_path("E", "inputs", 1), lambda t: 7.0 * loop_on(t), frames)
    marks = (EV["loop_start"] - 0.1,) + LOOP_PASSES[:3]
    for n, counter in enumerate(rig["counters"]):
        end = marks[n + 1] if n < 3 else LOOP_PASSES[3] + 0.6
        bake_visible(counter, lambda t, a=marks[n], b=end: a <= t < b, frames)
    bake_fn(rig["hinge"], "rotation_euler", lambda t: (0.0, 0.0, math.radians(-28.0) * smooth(span(t, EV["switch"], EV["switch"] + 0.05))),
            frames_between(EV["switch"] - 0.1, EV["switch"] + 0.2), 3)

    launcher = rig["launcher"]
    recoil = lambda t: -0.16 * min(1.0, sum(flash(t, tf, 0.015, 0.1) for tf, _ in FIRES))
    bake_fn(launcher, "location", lambda t: (-11.2 + recoil(t), 0.0, 0.0), frames, 3)

    def muzzle(t):
        weights = [(0.8, RGB["ice"])] + [(14.0 * flash(t, tf, 0.01, 0.12), RGB[c]) for tf, c in FIRES]
        total = sum(w for w, _ in weights)
        return total, tuple(sum(w * c[i] for w, c in weights) / total for i in range(3))

    bake_fn(mats["muzzle"].node_tree, node_path("E", "inputs", 1), lambda t: muzzle(t)[0], frames)
    bake_fn(mats["muzzle"].node_tree, node_path("E", "inputs", 0), lambda t: muzzle(t)[1], frames, 3)
    arrivals = [s["hide"] - 0.04 for s in SPECS if not s["blocked"] and s["name"] not in ("env", "fetch", "turn")]

    def port(t):
        weights = [(1.6 * studio(t) + 0.2, RGB["ice"]), (6.0 * window(t, EV["env_out"] - 0.1, EV["env_out"] + 0.5, 0.05, 0.3), RGB["gold"])]
        weights += [(7.0 * flash(t, ta, 0.02, 0.18), RGB["emerald"]) for ta in arrivals]
        total = sum(w for w, _ in weights)
        return total, tuple(sum(w * c[i] for w, c in weights) / total for i in range(3))

    bake_fn(mats["port"].node_tree, node_path("E", "inputs", 1), lambda t: port(t)[0], frames)
    bake_fn(mats["port"].node_tree, node_path("E", "inputs", 0), lambda t: port(t)[1], frames, 3)
    bake_fn(mats["core"].node_tree, node_path("E", "inputs", 1), lambda t: (5.0 + 1.5 * math.sin(2 * math.pi * t / 2.2)) * (0.3 + 0.7 * studio(t)), frames)
    for name in ("trackline", "label_dim"):
        level = mats[name].node_tree.nodes["E"].inputs[1].default_value
        bake_fn(mats[name].node_tree, node_path("E", "inputs", 1), lambda t, k=level: k * studio(t), frames)

    for name in ("key", "key_b", "rim_l", "rim_r", "fill", "wall"):
        bake_fn(rig[name].data, "energy", lambda t, e=rig[name].data.energy: e * studio(t), frames)
    bake_fn(rig["rim_r"].data, "color", rim_color, frames, 3)
    bake_fn(rig["flash"].data, "energy", lambda t: 2200.0 * impact_flash(t) + 600.0 * flash(t, EV["gate_land"], 0.01, 0.15), frames)

    rm_nose = (GATE_X - 0.3, 0.0, CAP_Z)
    rig["shards"].burst(EV["shatter"], rm_nose, (0.55, 0.2, 0.2), (-6.0, -1.0, 0.5), (-0.8, 2.5, 5.0), 1.9)
    for spec in SPECS:
        if spec["blocked"] and spec["name"] != "rm":
            rig["shards_b"].burst(spec["hide"], rm_nose, (0.5, 0.18, 0.18), (-5.0, -0.8, 0.5), (-0.8, 2.0, 4.0), 1.05)
    for side in (-1, 1):
        rig["sparks"].burst(EV["gate_land"], (GATE_X, side * 0.95, 0.05), (0.25, 0.25, 0.02), (-3.5, side * 0.5 - 2.0, 1.0),
                            (3.5, side * 0.5 + 2.0, 4.5), 0.55, share=0.5)
    rig["sparks"].burst(EV["shatter"], rm_nose, (0.1, 0.15, 0.15), (-7.0, -3.0, -1.0), (-1.0, 3.0, 5.0), 0.6)
    rig["sparks"].burst(EV["cut"], rig["cut_point"], (0.02, 0.05, 0.05), (-5.0, -2.5, -2.0), (-0.5, 2.5, 3.5), 0.65)
    for pool in ("shards", "shards_b", "sparks"):
        rig[pool].bake()


def blender_main(argv):
    p = argparse.ArgumentParser()
    p.add_argument("--blender", action="store_true")
    p.add_argument("--fonts", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--samples", type=int, default=64)
    p.add_argument("--scale", type=int, default=100)
    p.add_argument("--device", default="OPTIX")
    p.add_argument("--frames", default="")
    p.add_argument("--range", default="")
    a = p.parse_args(argv)
    started = time.time()
    scene, device = bl_setup(a.samples, a.scale, a.device)
    fonts = {k: bpy.data.fonts.load(str(Path(a.fonts) / f)) for k, f in FONTS.items()}
    rig = build_scene(fonts)
    animate_cameras(build_cameras())
    animate_capsules(rig)
    animate_stage(rig)
    print(f"PWX scene ready in {time.time() - started:.1f}s on {device}", flush=True)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.range:
        first, last = (int(v) for v in a.range.split(":"))
        scene.frame_start, scene.frame_end = first, last
        scene.render.filepath = str(out / "f_#####")
        started = time.time()
        bpy.ops.render.render(animation=True)
        print(f"PWX rendered {last - first + 1} frames in {time.time() - started:.1f}s", flush=True)
        return
    for f in [int(v) for v in a.frames.split(",") if v]:
        target_path = out / f"f_{f:05d}.png"
        if target_path.exists():
            continue
        t0 = time.time()
        scene.frame_set(f)
        scene.render.filepath = str(target_path)
        bpy.ops.render.render(write_still=True)
        print(f"PWX frame {f} {time.time() - t0:.2f}s", flush=True)


WHITE = (247, 247, 250)
GRAY = (172, 178, 190)
RED = (255, 69, 58)
GREEN = (52, 222, 112)
AMBER = (255, 176, 40)
GOLD = (255, 206, 92)

TITLES = [
    (EV["hook_a"], EV["hook_out"], 430, "slam", [("YOUR", "black", 176, WHITE), ("AI", "black", 176, WHITE)]),
    (EV["hook_b"], EV["hook_out"], 622, "slam", [("HAS", "black", 176, WHITE), ("A", "black", 176, WHITE), ("SHELL.", "black", 176, RED)]),
    (EV["cap_stop"], EV["cap_stop_out"], 140, "rise",
     [("STOPPED", "heavy", 96, WHITE), ("BEFORE", "heavy", 96, GRAY), ("IT", "heavy", 96, GRAY), ("RUNS.", "heavy", 96, GRAY)]),
    (EV["cap_mask"], EV["cap_mask_out"], 140, "rise", [("SECRETS", "heavy", 96, WHITE), ("MASKED.", "heavy", 96, GOLD)]),
    (EV["cap_leak"], EV["cap_leak_out"], 140, "rise", [("LEAKS", "heavy", 96, WHITE), ("BLOCKED.", "heavy", 96, RED)]),
    (EV["cap_loop"], EV["cap_loop_out"], 140, "rise", [("LOOPS", "heavy", 96, WHITE), ("BROKEN.", "heavy", 96, GREEN)]),
    (EV["cap_s1"], EV["cap_s1_out"], 140, "rise",
     [("LOCAL", "heavy", 96, WHITE), ("AI", "heavy", 96, WHITE), ("JUDGE.", "heavy", 96, WHITE), ("$0.", "heavy", 96, AMBER)]),
    (EV["stats"], EV["stats_out"], 380, "count", [("167,210", "black", 150, WHITE), ("CALLS.", "black", 150, WHITE)]),
    (EV["stats_zero"], EV["stats_out"], 540, "slam", [("0", "black", 104, GREEN), ("DESTRUCTIVE", "black", 104, WHITE), ("ESCAPES.", "black", 104, WHITE)]),
    (EV["lockup"], DURATION + 1, 450, "rise", [("pi-warden", "black", 210, WHITE)]),
    (EV["lockup"] + 0.45, DURATION + 1, 598, "rise",
     [("Pi", "semi", 54, GRAY), ("·", "semi", 54, GRAY), ("Claude Code", "semi", 54, GRAY), ("·", "semi", 54, GRAY), ("Codex", "semi", 54, GRAY)]),
    (EV["lockup"] + 0.75, DURATION + 1, 672, "rise", [("0 API KEYS", "heavy", 54, WHITE), ("·", "heavy", 54, GRAY), ("$0", "heavy", 54, AMBER)]),
    (EV["lockup"] + 1.05, DURATION + 1, 790, "rise", [("pi install npm:pi-warden", "mono", 38, GRAY)]),
]
SCRIMS = ((EV["stats"] - 0.1, EV["stats_out"] + 0.2), (EV["lockup"] - 0.1, DURATION + 1.0))


class Titles:
    def __init__(self, font_dir):
        from PIL import ImageFont

        self.ImageFont = ImageFont
        self.font_dir = Path(font_dir)
        self.cache = {}
        self.blocks = [self._block(spec) for spec in TITLES]

    def font(self, key, size):
        if (key, size) not in self.cache:
            self.cache[(key, size)] = self.ImageFont.truetype(str(self.font_dir / FONTS[key]), size)
        return self.cache[(key, size)]

    def glyph(self, text, font, color):
        from PIL import Image, ImageDraw, ImageFilter

        left, top, right, bottom = font.getbbox(text, anchor="ls")
        pad = 28
        img = Image.new("RGBA", (right - left + 2 * pad, bottom - top + 2 * pad), (0, 0, 0, 0))
        ImageDraw.Draw(img).text((pad - left, pad - top), text, font=font, fill=(*color, 255), anchor="ls")
        shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
        shadow.putalpha(img.getchannel("A").filter(ImageFilter.GaussianBlur(12)).point(lambda v: int(v * 0.6)))
        return dict(img=img, shadow=shadow, ox=pad - left, oy=pad - top)

    def _block(self, spec):
        t_in, t_out, cy, style, spans = spec
        words, x = [], 0.0
        for i, (text, key, size, color) in enumerate(spans):
            font = self.font(key, size)
            if style == "count" and i == 0:
                digits = {ch: dict(self.glyph(ch, font, color), adv=font.getlength(ch)) for ch in "0123456789,"}
                cell = max(font.getlength(d) for d in "0123456789")
                cells = []
                for ch in text:
                    width = cell if ch.isdigit() else font.getlength(ch)
                    cells.append((ch, x, width))
                    x += width
                words.append(dict(kind="count", cells=cells, digits=digits, x=0.0))
            else:
                word = self.glyph(text, font, color)
                word.update(kind="word", x=x)
                words.append(word)
                x += font.getlength(text)
            if i < len(spans) - 1:
                x += font.getlength(" ")
        cap = -self.font(spans[0][1], spans[0][2]).getbbox("H", anchor="ls")[1]
        return dict(t_in=t_in, t_out=t_out, style=style, words=words, x0=(WIDTH - x) / 2, baseline=cy + cap / 2, cy=cy)

    @staticmethod
    def paste(overlay, img, x, y, opacity, blur, scale=1.0):
        from PIL import Image, ImageFilter

        if opacity <= 0.003:
            return
        if abs(scale - 1.0) > 1e-3:
            img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.BICUBIC)
        if blur > 0.3:
            img = img.filter(ImageFilter.GaussianBlur(blur))
        if opacity < 0.999:
            img = img.copy()
            img.putalpha(img.getchannel("A").point(lambda v: int(v * opacity)))
        x, y = round(x), round(y)
        if x < 0 or y < 0:
            img = img.crop((max(0, -x), max(0, -y), img.width, img.height))
            x, y = max(0, x), max(0, y)
        if x >= overlay.width or y >= overlay.height or img.width == 0 or img.height == 0:
            return
        overlay.alpha_composite(img, dest=(x, y))

    def draw(self, frame, t):
        from PIL import Image

        active = [b for b in self.blocks if b["t_in"] - 0.01 <= t <= b["t_out"] + 0.3]
        scrim = max(window(t, a, b, 0.35, 0.35) for a, b in SCRIMS)
        band = max([window(t, b["t_in"] - 0.1, b["t_out"] + 0.3, 0.25, 0.35) for b in active if b["cy"] < 300] + [0.0])
        if not active and scrim <= 0:
            return frame
        overlay = Image.new("RGBA", frame.size, (0, 0, 0, 0))
        if scrim > 0:
            overlay = Image.alpha_composite(overlay, self._scrim(frame.size, scrim))
        if band > 0:
            overlay = Image.alpha_composite(overlay, self._band(frame.size, band))
        for block in active:
            self._draw_block(overlay, block, t)
        return Image.alpha_composite(frame.convert("RGBA"), overlay).convert("RGB")

    def _scrim(self, size, level):
        from PIL import Image, ImageDraw, ImageFilter

        if "scrim" not in self.cache:
            mask = Image.new("L", (size[0] // 4, size[1] // 4), 0)
            ImageDraw.Draw(mask).ellipse((size[0] // 4 * 0.12, size[1] // 4 * 0.18, size[0] // 4 * 0.88, size[1] // 4 * 0.68), fill=200)
            self.cache["scrim"] = mask.filter(ImageFilter.GaussianBlur(40)).resize(size, Image.BILINEAR)
        layer = Image.new("RGBA", size, (2, 3, 5, 0))
        layer.putalpha(self.cache["scrim"].point(lambda v: int(v * level)))
        return layer

    def _band(self, size, level):
        from PIL import Image

        if "band" not in self.cache:
            column = Image.new("L", (1, size[1]), 0)
            column.putdata([int(165 * max(0.0, 1.0 - y / 340.0) ** 1.6) for y in range(size[1])])
            self.cache["band"] = column.resize(size, Image.NEAREST)
        layer = Image.new("RGBA", size, (2, 3, 5, 0))
        layer.putalpha(self.cache["band"].point(lambda v: int(v * level)))
        return layer

    def _draw_block(self, overlay, block, t):
        t_in, style = block["t_in"], block["style"]
        out = span(t, block["t_out"], block["t_out"] + 0.25)
        for i, word in enumerate(block["words"]):
            if style in ("slam", "count"):
                u = span(t, t_in, t_in + 0.16)
                scale = 1.0 + 0.3 * (1.0 - ease_out(u, 3.0))
                opacity = span(t, t_in, t_in + 0.05)
                blur, dy = 5.0 * (1.0 - u), 0.0
            else:
                local = t - t_in - 0.07 * i
                u = span(local, 0.0, 0.5)
                scale, opacity = 1.0, span(local, 0.0, 0.22)
                blur, dy = 6.0 * (1.0 - u) ** 2, 34.0 * (1.0 - ease_out(u, 4.0))
            opacity *= 1.0 - out
            dy -= 18.0 * out
            blur += 5.0 * out
            if opacity <= 0.003:
                continue
            cx, cy = WIDTH / 2, block["cy"]
            if word["kind"] == "count":
                self._draw_count(overlay, block, word, t, scale, opacity, blur, dy)
                continue
            bx = cx + (block["x0"] + word["x"] - cx) * scale
            by = cy + (block["baseline"] - cy) * scale + dy
            self.paste(overlay, word["shadow"], bx - word["ox"] * scale, by - word["oy"] * scale + 4, opacity, blur, scale)
            self.paste(overlay, word["img"], bx - word["ox"] * scale, by - word["oy"] * scale, opacity, blur, scale)

    def _draw_count(self, overlay, block, word, t, scale, opacity, blur, dy):
        cx, cy = WIDTH / 2, block["cy"]
        slot = 0
        frame_no = int(t * FPS)
        for ch, x, width in word["cells"]:
            shown, drop = ch, 0.0
            if ch.isdigit():
                settle = COUNT_SETTLE[slot]
                if t < settle:
                    shown = str((int(ch) + frame_no * 7 + slot * 3) % 10)
                else:
                    drop = -12.0 * (1.0 - ease_out(span(t, settle, settle + 0.08)))
                slot += 1
            g = word["digits"][shown]
            gx = cx + (block["x0"] + x + (width - g["adv"]) / 2 - cx) * scale
            gy = cy + (block["baseline"] - cy) * scale + dy + drop
            self.paste(overlay, g["shadow"], gx - g["ox"] * scale, gy - g["oy"] * scale + 4, opacity, blur, scale)
            self.paste(overlay, g["img"], gx - g["ox"] * scale, gy - g["oy"] * scale, opacity, blur, scale)


class Grade:
    def __init__(self, font_dir, bloom=0.5):
        import numpy as np

        self.np = np
        self.titles = Titles(font_dir)
        self.bloom = bloom
        yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float32)
        r = np.sqrt(((xx - WIDTH / 2) / (WIDTH / 2)) ** 2 + ((yy - HEIGHT / 2) / (HEIGHT / 2)) ** 2) / math.sqrt(2)
        self.vignette = (1.0 - 0.34 * r ** 2.2)[..., None].astype(np.float32)

    def __call__(self, path, t):
        from PIL import Image
        from scipy.ndimage import gaussian_filter

        np = self.np
        img = Image.open(path).convert("RGB")
        if img.size != (WIDTH, HEIGHT):
            img = img.resize((WIDTH, HEIGHT), Image.LANCZOS)
        base = np.asarray(img, dtype=np.float32) / 255.0
        small = np.asarray(img.reduce(4), dtype=np.float32) / 255.0
        lum = small @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
        bright = small * (np.clip((lum - 0.5) / 0.5, 0.0, 1.0) ** 2)[..., None]
        glow = 0.6 * gaussian_filter(bright, (3, 3, 0)) + 0.4 * gaussian_filter(bright, (12, 12, 0))
        glow_img = Image.fromarray((np.clip(glow * 1.6, 0.0, 1.0) * 255).astype(np.uint8)).resize((WIDTH, HEIGHT), Image.BILINEAR)
        glow_full = np.asarray(glow_img, dtype=np.float32) / 255.0
        out = 1.0 - (1.0 - base) * (1.0 - self.bloom * glow_full)
        out *= self.vignette
        noise = np.random.default_rng(int(t * FPS) + 7).random((HEIGHT, WIDTH, 1), dtype=np.float32) - 0.5
        frame = Image.fromarray(np.clip(out * 255.0 + noise, 0, 255).astype(np.uint8))
        return self.titles.draw(frame, t)


_GRADE = None


def _grade_init(font_dir):
    global _GRADE
    _GRADE = Grade(font_dir)


def _grade_one(job):
    path, frame, keep = job
    img = _GRADE(path, frame / FPS)
    if keep:
        img.save(keep)
    return img.tobytes()


def grade_frames(beauty, frames, font_dir, sink=None, keep=None):
    import multiprocessing

    keep = keep or {}
    jobs = [(str(beauty / f"f_{f:05d}.png"), f, str(keep[f]) if f in keep else None) for f in frames]
    workers = max(1, min(len(jobs), os.cpu_count() or 1))
    with multiprocessing.get_context("fork").Pool(workers, initializer=_grade_init, initargs=(str(font_dir),)) as pool:
        for data in pool.imap(_grade_one, jobs, chunksize=2):
            if sink:
                sink(data)


def synth_audio(path):
    import numpy as np
    from scipy import signal
    from scipy.io import wavfile

    sr = SAMPLE_RATE
    n = int(round(DURATION * sr))
    rng = np.random.default_rng(20261125)
    dry, wet, bed = np.zeros((2, n)), np.zeros((2, n)), np.zeros((2, n))

    def secs(d):
        return np.arange(int(round(d * sr))) / sr

    def noise(d):
        return rng.standard_normal(int(round(d * sr)))

    def filt(x, kind, freq, order=2):
        return signal.sosfilt(signal.butter(order, freq, btype=kind, fs=sr, output="sos"), x)

    def env(d, attack, tau):
        t = secs(d)
        return np.exp(-t / tau) * np.clip(t / max(attack, 1e-4), 0.0, 1.0)

    def glide(d, f0, f1, tau):
        t = secs(d)
        return np.sin(2 * np.pi * np.cumsum(f1 + (f0 - f1) * np.exp(-t / tau)) / sr)

    def partials(d, freqs, decays, amps):
        t = secs(d)
        return sum(a * np.sin(2 * np.pi * f * t + rng.uniform(0, 6.28)) * np.exp(-t / dc) for f, dc, a in zip(freqs, decays, amps))

    def place(bus, x, t0, pan=0.0, gain=1.0):
        i0 = int(round(t0 * sr))
        pan = np.broadcast_to(np.asarray(pan, dtype=float), x.shape)
        if i0 < 0:
            x, pan, i0 = x[-i0:], pan[-i0:], 0
        if i0 >= n or len(x) == 0:
            return
        x, pan = x[: n - i0], pan[: n - i0]
        theta = (np.clip(pan, -1.0, 1.0) + 1.0) * np.pi / 4
        bus[0, i0:i0 + len(x)] += gain * x * np.cos(theta)
        bus[1, i0:i0 + len(x)] += gain * x * np.sin(theta)

    def pad_to(x, d):
        return np.pad(x, (0, max(0, int(round(d * sr)) - len(x))))[: int(round(d * sr))]

    def thump(f0=120.0, f1=38.0, tau=0.22):
        d = 1.0
        body = glide(d, f0, f1, 0.05) * env(d, 0.002, tau)
        click = pad_to(filt(noise(0.012), "highpass", 2500) * env(0.012, 0.0005, 0.003), d)
        whomp = filt(noise(d), "lowpass", 240) * env(d, 0.004, 0.09)
        return 0.9 * body + 0.25 * click + 0.5 * whomp

    def chime(f0, gain_decay=1.0):
        ratios, decays, amps = (1.0, 2.0, 2.76, 4.07, 5.4), (2.2, 1.4, 1.0, 0.6, 0.4), (1.0, 0.35, 0.45, 0.2, 0.12)
        return partials(3.0, [f0 * r for r in ratios], [d * gain_decay for d in decays], amps) * env(3.0, 0.002, 10.0)

    def grains(d, count, lo, hi, tau, seed_pan=0.3):
        out = np.zeros(int(round(d * sr)))
        for _ in range(count):
            t0 = rng.exponential(tau)
            if t0 >= d - 0.01:
                continue
            g = filt(noise(rng.uniform(0.002, 0.006)), "bandpass", (lo, hi)) * rng.uniform(0.2, 1.0)
            i = int(t0 * sr)
            out[i:i + len(g)] += g[: len(out) - i] * math.exp(-t0 / (tau * 2))
        return out

    def moving_noise(times, speed, pan, gain, base=300.0, top=3800.0, block=512):
        src = noise(len(times) / sr)
        out = np.empty_like(src)
        zi = np.zeros((1, 2))
        for b in range(0, len(src), block):
            v = float(speed[min(b, len(speed) - 1)])
            sos = signal.butter(2, min(base + top * v, sr * 0.45), btype="lowpass", fs=sr, output="sos")
            out[b:b + block], zi = signal.sosfilt(sos, src[b:b + block], zi=zi)
        return out * gain * np.clip(speed, 0.0, 1.5) ** 1.4, pan

    for spec in SPECS:
        t0, t1 = spec["show"], min(spec["hide"], DURATION)
        if t1 - t0 < 0.05:
            continue
        tc = np.arange(t0, t1 + 0.01, 0.01)
        pts = np.array([spec["path"](t)[:3] for t in tc])
        speed = np.linalg.norm(np.gradient(pts, tc, axis=0), axis=1) / 14.0
        ts = t0 + np.arange(int((t1 - t0) * sr)) / sr
        sig, pan = moving_noise(ts, np.interp(ts, tc, speed), np.clip(np.interp(ts, tc, pts[:, 0]) / 11.0, -0.85, 0.85),
                                0.16 if spec["name"] != "rm" else 0.22)
        place(dry, sig, t0, pan)
    for tf, color in FIRES:
        boom = thump(150.0, 55.0, 0.12) * 0.7 + filt(noise(1.0), "bandpass", (200, 2000)) * env(1.0, 0.002, 0.06) * 0.5
        place(dry, boom, tf, -0.75, 0.5 if tf == EV["fire_rm"] else 0.28)

    place(dry, thump(), EV["hook_a"], 0.0, 0.85)
    place(dry, thump(110.0, 34.0, 0.26), EV["hook_b"], 0.0, 0.95)
    clunk = filt(noise(0.4), "lowpass", 900) * env(0.4, 0.002, 0.05) * 0.5 + np.sin(2 * np.pi * 120 * secs(0.4)) * env(0.4, 0.002, 0.08) * 0.35
    place(dry, clunk, EV["lights"], 0.0, 0.6)

    rm_d = EV["freeze"] - EV["fire_rm"]
    t = secs(rm_d)
    menace = (np.sin(2 * np.pi * 55 * t) + 0.5 * np.sin(2 * np.pi * 110.5 * t) + 0.3 * np.sin(2 * np.pi * 3100 * t + 2 * np.sin(2 * np.pi * 7 * t)))
    menace *= np.clip(t / 0.08, 0, 1) * np.exp(-np.clip(t - (2.5 - EV["fire_rm"]), 0, None) / 0.25)
    place(dry, filt(menace, "lowpass", 4000), EV["fire_rm"], np.linspace(-0.7, 0.3, len(t)), 0.12)
    riser_d = EV["gate_drop"] - 2.55
    t = secs(riser_d)
    riser = filt(noise(riser_d), "bandpass", (400, 6000)) * (t / riser_d) ** 2.2 + 0.4 * np.sin(2 * np.pi * np.cumsum(220 + 900 * (t / riser_d) ** 2) / sr) * (t / riser_d) ** 1.5
    place(wet, riser, 2.55, 0.2, 0.16)

    land = EV["gate_land"]
    sub = glide(2.2, 62.0, 28.0, 0.6) * env(2.2, 0.003, 0.55)
    clang = partials(2.0, (210, 457, 812, 1333, 2047, 3120), (1.2, 0.9, 0.7, 0.5, 0.35, 0.25), (1.0, 0.7, 0.5, 0.35, 0.25, 0.15))
    crack = filt(noise(0.5), "highpass", 800) * env(0.5, 0.0005, 0.03)
    boom = filt(noise(1.5), "lowpass", 180) * env(1.5, 0.003, 0.35)
    place(dry, sub, land, 0.0, 1.0)
    place(dry, boom, land, 0.0, 0.8)
    place(dry, crack, land, 0.15, 0.5)
    place(wet, clang, land, 0.2, 0.22)
    place(dry, grains(0.6, 90, 3000, 9000, 0.12), land, 0.3, 0.2)

    shatter = EV["shatter"]
    place(dry, grains(0.9, 320, 2000, 10000, 0.16), shatter, 0.25, 0.4)
    tinkle = sum(pad_to(partials(0.3, [rng.uniform(2500, 7000)], [rng.uniform(0.03, 0.12)], [1.0]), 0.3) for _ in range(26))
    place(wet, tinkle, shatter + 0.02, 0.3, 0.05)
    place(dry, filt(noise(0.5), "bandpass", (800, 5000)) * env(0.5, 0.001, 0.05), shatter, 0.25, 0.5)
    place(dry, thump(90.0, 40.0, 0.18), shatter, 0.2, 0.45)
    place(wet, filt(noise(2.0), "highpass", 3000) * env(2.0, 0.01, 0.6), shatter, 0.2, 0.03)

    for te, color, kind in EVENTS:
        if kind == "pass":
            chirp = glide(0.4, 1046.5, 1568.0, 0.04) * env(0.4, 0.004, 0.12) + 0.3 * glide(0.4, 2093.0, 3136.0, 0.04) * env(0.4, 0.004, 0.08)
            place(wet, chirp, te, 0.35, 0.1)
        elif kind == "block" and te > shatter + 1.0:
            place(dry, grains(0.6, 160, 2000, 9000, 0.14), te, 0.3, 0.3)
            place(dry, thump(100.0, 45.0, 0.14), te, 0.3, 0.35)

    a, b = ENV_WINDOW
    place(wet, chime(1318.5), a, 0.2, 0.16)
    place(wet, chime(1568.0, 0.8), b, 0.0, 0.1)
    t = secs(b - a + 0.4)
    shimmer = filt(noise(b - a + 0.4), "bandpass", (5000, 11000)) * (0.6 + 0.4 * np.sin(2 * np.pi * 18 * t)) * np.clip(t / 0.15, 0, 1) * np.exp(-np.clip(t - (b - a), 0, None) / 0.15)
    place(wet, shimmer, a, 0.1, 0.035)

    t = secs(0.5)
    sq = np.sign(np.sin(2 * np.pi * 24 * t))
    fm = np.sin(2 * np.pi * np.cumsum(900 * np.exp(-t / 0.25) + 300) / sr + 3 * np.sin(2 * np.pi * 450 * t))
    place(dry, fm * (0.6 + 0.4 * sq) * env(0.5, 0.01, 0.3), EV["fetch_drop"], -0.1, 0.12)
    place(dry, thump(140.0, 60.0, 0.08), 11.70, -0.1, 0.25)
    laser_d = EV["cut"] - EV["laser"]
    t = secs(laser_d + 0.6)
    saw = sum(np.sin(2 * np.pi * 110 * k * t) / k for k in range(1, 12))
    buzz = filt(saw, "highpass", 300) * np.clip(t / 0.01, 0, 1) * np.where(t < laser_d, 1.0, np.exp(-(t - laser_d) / 0.03))
    place(dry, buzz, EV["laser"], 0.4, 0.12)
    place(dry, glide(0.2, 2000.0, 400.0, 0.04) * env(0.2, 0.002, 0.08), EV["laser"], 0.4, 0.22)
    shing = partials(1.5, (2637, 3520, 4699, 6272), (0.6, 0.45, 0.35, 0.25), (1.0, 0.7, 0.5, 0.3)) + filt(noise(1.5), "highpass", 4000) * env(1.5, 0.001, 0.05)
    place(wet, shing, EV["cut"], 0.35, 0.22)
    place(dry, grains(0.5, 120, 2500, 9000, 0.1), EV["cut"], 0.4, 0.25)

    for k, p in enumerate((EV["loop_start"],) + LOOP_PASSES[:3]):
        tick = partials(0.2, (1568.0 * (1.122 ** k), 3136.0 * (1.122 ** k)), (0.05, 0.03), (1.0, 0.4)) + pad_to(filt(noise(0.004), "highpass", 3000), 0.2) * 0.4
        place(dry, tick, p, -0.1, 0.18)
    t = secs(LOOP_PASSES[3] - EV["loop_start"])
    whirr_rate = np.interp(t + EV["loop_start"], [EV["loop_start"], *LOOP_PASSES], [1 / 0.95, 1 / 0.95, 1 / 0.88, 1 / 0.8, 1 / 0.72])
    phase = 2 * np.pi * np.cumsum(whirr_rate) / sr
    whirr = filt(noise(len(t) / sr), "bandpass", (300, 2400)) * (0.55 + 0.45 * np.cos(phase)) + 0.3 * np.sin(2 * np.pi * np.cumsum(70 + 40 * whirr_rate) / sr)
    place(dry, whirr * np.clip(t / 0.1, 0, 1), EV["loop_start"], -0.1, 0.12)
    click_a = pad_to(filt(noise(0.003), "highpass", 2000), 0.12) * 0.6 + partials(0.12, (2900.0,), (0.03,), (0.6,))
    click_b = pad_to(filt(noise(0.008), "lowpass", 1500), 0.15) * 0.8 + partials(0.15, (640.0,), (0.05,), (0.7,))
    place(dry, click_a, EV["switch"], -0.15, 0.45)
    place(dry, click_b, EV["switch"] + 0.028, -0.15, 0.5)

    t = secs(0.9)
    bloop = np.sin(2 * np.pi * np.cumsum(196 + 196 * (1 - np.exp(-t / 0.06))) / sr) * env(0.9, 0.01, 0.3)
    place(wet, bloop + 0.3 * np.sin(2 * np.pi * 588 * t) * env(0.9, 0.01, 0.2), EV["s1_pulse"], 0.3, 0.3)
    hum_d = EV["turn_fade"] + 0.2 - EV["s1_beam"]
    t = secs(hum_d)
    hum = (np.sin(2 * np.pi * 440 * t) + 0.6 * np.sin(2 * np.pi * 660 * t)) * (0.7 + 0.3 * np.sin(2 * np.pi * 5 * t))
    place(wet, hum * np.clip(t / 0.15, 0, 1) * np.clip((hum_d - t) / 0.3, 0, 1), EV["s1_beam"], 0.2, 0.035)
    place(wet, partials(1.5, (1760.0, 2640.0), (0.4, 0.3), (1.0, 0.5)), EV["lock"], 0.1, 0.16)

    place(dry, thump(80.0, 40.0, 0.3), EV["stats"], 0.0, 0.55)
    for k, ts in enumerate(COUNT_SETTLE):
        place(dry, partials(0.12, (2200.0 + 140 * k,), (0.025,), (1.0,)), ts, -0.3 + 0.12 * k, 0.12)
    place(dry, thump(100.0, 36.0, 0.3), EV["stats_zero"], 0.0, 0.8)
    place(wet, partials(2.0, (523.25, 784.0, 1046.5), (0.9, 0.7, 0.5), (0.6, 0.4, 0.3)), EV["stats_zero"], 0.0, 0.14)

    lock_d = DURATION - EV["lockup"]
    t = secs(lock_d)
    chord = (146.83, 220.0, 369.99, 440.0, 554.37, 659.25)
    pad = sum(sum(np.sin(2 * np.pi * f * (1 + c * 0.0023) * t + rng.uniform(0, 6.28)) for c in (-1, 0, 1)) / 3
              + 0.25 * np.sin(2 * np.pi * 2 * f * t) for f in chord)
    pad = filt(pad, "lowpass", 2600) * np.clip(t / 1.2, 0, 1) * np.clip((lock_d - t) / 1.0, 0, 1)
    place(wet, pad, EV["lockup"], 0.0, 0.05)
    place(wet, chime(1174.66, 1.2), EV["lockup"], 0.0, 0.12)
    place(dry, np.sin(2 * np.pi * 73.42 * t) * np.clip(t / 0.8, 0, 1) * np.clip((lock_d - t) / 1.2, 0, 1), EV["lockup"], 0.0, 0.12)

    t = secs(EV["lockup"] + 1.0 - EV["lights"])
    drone = (np.sin(2 * np.pi * 55 * t) + 0.5 * np.sin(2 * np.pi * 82.41 * t)) * (0.8 + 0.2 * np.sin(2 * np.pi * 0.1 * t))
    drone += 0.6 * filt(noise(len(t) / sr), "lowpass", 400)
    place(bed, drone * np.clip(t / 0.6, 0, 1) * np.clip((t[-1] - t) / 1.0, 0, 1), EV["lights"], 0.0, 0.03)
    duck = np.ones(n)
    for t0 in (EV["gate_land"], EV["shatter"], EV["stats_zero"]):
        i = int(t0 * sr)
        tt = np.arange(n - i) / sr
        duck[i:] *= 1.0 - 0.6 * np.exp(-tt / 0.5)

    d = 1.8
    t = secs(d)
    ir = np.stack([filt(rng.standard_normal(len(t)), "lowpass", 5200) * np.exp(-t / 0.42) for _ in range(2)])
    ir[:, : int(0.012 * sr)] = 0.0
    ir /= np.sqrt(np.sum(ir ** 2, axis=1, keepdims=True))
    send = wet + 0.2 * dry
    verb = np.stack([signal.fftconvolve(send[c], ir[c])[:n] for c in range(2)])
    master = dry + wet + 0.45 * verb + bed * duck
    master = np.stack([filt(master[c], "highpass", 24) for c in range(2)])
    fade = np.ones(n)
    fade[: int(0.01 * sr)] = np.linspace(0, 1, int(0.01 * sr))
    fade[-int(0.5 * sr):] *= np.linspace(1, 0, int(0.5 * sr))
    master *= fade
    master /= max(np.max(np.abs(master)), 1e-9) / 0.89
    raw = Path(path).with_name("mix-raw.wav")
    wavfile.write(raw, sr, master.T.astype(np.float32))
    stats = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(raw), "-af", "loudnorm=I=-14:TP=-1.0:LRA=11:print_format=json",
                            "-f", "null", "-"], capture_output=True, text=True, check=True).stderr
    measured = json.loads(stats[stats.rindex("{"):stats.rindex("}") + 1])
    filt_args = (f"loudnorm=I=-14:TP=-1.0:LRA=11:measured_I={measured['input_i']}:measured_TP={measured['input_tp']}"
                 f":measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}"
                 f":offset={measured['target_offset']}:linear=true")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-af", filt_args, "-ar", str(sr), "-c:a", "pcm_s24le",
                    str(path)], check=True)
    report = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                            capture_output=True, text=True, check=True).stderr
    summary = report[report.rindex("Summary:"):]
    loud = summary.split("I:")[1].split("LUFS")[0].strip()
    peak = summary.split("Peak:")[1].split("dBFS")[0].strip()
    print(f"audio: integrated {loud} LUFS, true peak {peak} dBFS", flush=True)


def download(url, dest, sha256=None):
    tmp = dest.with_name(dest.name + ".part")
    with urllib.request.urlopen(url, timeout=180) as response, open(tmp, "wb") as fh:
        shutil.copyfileobj(response, fh, length=1 << 20)
    if sha256:
        digest = hashlib.sha256()
        with open(tmp, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                digest.update(chunk)
        if digest.hexdigest() != sha256:
            tmp.unlink()
            raise SystemExit(f"checksum mismatch for {url}: {digest.hexdigest()}")
    tmp.replace(dest)


def ensure_blender(work):
    blender = work / f"blender-{BLENDER_VERSION}-linux-x64" / "blender"
    if not blender.exists():
        archive = work / "blender.tar.xz"
        download(BLENDER_URL, archive, BLENDER_SHA256)
        subprocess.run(["tar", "-xJf", str(archive), "-C", str(work)], check=True)
        archive.unlink()
    print(f"blender: {BLENDER_VERSION}", flush=True)
    return blender


def ensure_fonts(work):
    fonts = work / "fonts"
    if not all((fonts / name).exists() for name in FONTS.values()):
        fonts.mkdir(parents=True, exist_ok=True)
        archive = fonts / "inter.zip"
        download(INTER_URL, archive, INTER_SHA256)
        with zipfile.ZipFile(archive) as z:
            for entry in z.namelist():
                base = entry.rsplit("/", 1)[-1]
                if entry.startswith("extras/ttf/") and base in FONTS.values():
                    (fonts / base).write_bytes(z.read(entry))
        archive.unlink()
        download(MONO_URL, fonts / FONTS["mono"], MONO_SHA256)
    return fonts


def rendered(path):
    return path.exists() and path.stat().st_size > 0


def source_digest():
    text = Path(__file__).read_text()
    return hashlib.sha256(text[text.find("#!/usr/bin/env python3"):].encode()).hexdigest()[:10]


def render_beauty(blender, fonts, beauty, frames=None, frame_range=None, samples=64, scale=100):
    beauty.mkdir(parents=True, exist_ok=True)
    log_path = beauty.parent / "blender.log"
    cmd = [str(blender), "-b", "--factory-startup", "-noaudio", "-P", str(Path(__file__).resolve()), "--", "--blender",
           "--fonts", str(fonts), "--out", str(beauty), "--samples", str(samples), "--scale", str(scale)]
    cmd += ["--range", f"{frame_range[0]}:{frame_range[1]}"] if frame_range else ["--frames", ",".join(str(f) for f in frames)]
    wanted = list(range(frame_range[0], frame_range[1] + 1)) if frame_range else list(frames)
    started, last_note = time.time(), 0.0
    with open(log_path, "a") as log:
        proc = subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT)
        while proc.poll() is None:
            time.sleep(5)
            if time.time() - last_note >= 60:
                done = sum(1 for f in wanted if rendered(beauty / f"f_{f:05d}.png"))
                print(f"render {done}/{len(wanted)} frames, {(time.time() - started) / 60:.1f} min", flush=True)
                last_note = time.time()
    lines = log_path.read_text(errors="replace").splitlines()
    for line in lines:
        if line.startswith("PWX "):
            print(line[:240], flush=True)
    if proc.returncode != 0:
        for line in lines[-25:]:
            print(line[:240], flush=True)
        raise SystemExit(f"blender exited {proc.returncode}")
    missing = [f for f in wanted if not rendered(beauty / f"f_{f:05d}.png")]
    if missing:
        raise SystemExit(f"blender left {len(missing)} frames unrendered, first {missing[:5]}")
    print(f"render done: {len(wanted)} frames in {(time.time() - started) / 60:.1f} min", flush=True)


def contact_sheet(stills, out, font_dir):
    from PIL import Image, ImageDraw, ImageFont

    cell_w, cell_h, gap = 960, 540, 24
    sheet = Image.new("RGB", (4 * cell_w + 5 * gap, 2 * cell_h + 3 * gap), (9, 10, 12))
    font = ImageFont.truetype(str(Path(font_dir) / FONTS["mono"]), 22)
    draw = ImageDraw.Draw(sheet)
    for i, (path, t) in enumerate(stills[:8]):
        x, y = gap + (i % 4) * (cell_w + gap), gap + (i // 4) * (cell_h + gap)
        sheet.paste(Image.open(path).convert("RGB").resize((cell_w, cell_h), Image.LANCZOS), (x, y))
        draw.text((x + 14, y + cell_h - 36), f"{t:05.2f}s", font=font, fill=(200, 205, 215))
    sheet.save(out)


def encode_video(beauty, frames, font_dir, mp4, audio=None, keep=None):
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS),
           "-i", "-"]
    if audio:
        cmd += ["-i", str(audio), "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", f"{AUDIO_KBPS}k", "-ar", str(SAMPLE_RATE)]
    cmd += ["-vf", "scale=out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int",
            "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-profile:v", "high", "-level:v", "4.2",
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
            "-movflags", "+faststart", str(mp4)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    started = time.time()
    grade_frames(beauty, frames, font_dir, sink=proc.stdin.write, keep=keep)
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit("ffmpeg failed while encoding")
    print(f"encoded {mp4.name}: {len(frames)} frames in {(time.time() - started) / 60:.1f} min, {mp4.stat().st_size / 1e6:.1f} MB", flush=True)


def make_gif(mp4, gif):
    ladder = [(0.0, DURATION, 15, 128), (0.0, DURATION, 12, 96), (0.0, DURATION, 10, 80), (0.0, DURATION, 10, 64),
              (0.0, 9.5, 15, 128), (0.0, 9.5, 12, 96)]
    for start, end, fps, colors in ladder:
        graph = (f"fps={fps},scale=960:540:flags=lanczos,split[a][b];[a]palettegen=max_colors={colors}:stats_mode=diff[p];"
                 f"[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle")
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{start}", "-t", f"{end - start}", "-i", str(mp4),
                        "-vf", graph, "-loop", "0", str(gif)], check=True)
        size = gif.stat().st_size
        print(f"gif {start:.1f}-{end:.1f}s {fps} fps {colors} colors: {size / 2 ** 20:.2f} MiB", flush=True)
        if size < 10 * 2 ** 20:
            return
    raise SystemExit("no GIF setting fits under 10 MiB")


# GitHub's web upload takes a video of at most 10 MB on a free plan.
WEB_LIMIT = 9.5 * 2 ** 20


def encode_web(mp4, web):
    kbps = round((9_400_000 - AUDIO_KBPS * 1000 / 8 * DURATION) * 8 / DURATION / 1000)
    passlog = web.with_name(web.stem + "-pass")
    video = ["-c:v", "libx264", "-preset", "slow", "-b:v", f"{kbps}k", "-x264-params", "aq-mode=3", "-pix_fmt", "yuv420p",
             "-profile:v", "high", "-level:v", "4.2", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
             "-color_range", "tv", "-passlogfile", str(passlog)]
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp4), "-map", "0:v", *video, "-pass", "1", "-f", "null", "-"],
                   check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp4), "-map", "0:v", "-map", "0:a", *video, "-pass", "2",
                    "-c:a", "copy", "-movflags", "+faststart", str(web)], check=True)
    for p in web.parent.glob(passlog.name + "*"):
        p.unlink()
    size = web.stat().st_size
    print(f"web copy {web.name}: {kbps} kb/s video, {size / 2 ** 20:.2f} MiB", flush=True)
    if size >= WEB_LIMIT:
        raise SystemExit(f"{web.name} is {size / 2 ** 20:.2f} MiB, over the 9.5 MiB limit")


def package(out, names, tar_path):
    with tarfile.open(tar_path, "w") as tar:
        for name in names:
            if (out / name).exists():
                tar.add(out / name, arcname=name)
    print(f"package {tar_path.name}: {tar_path.stat().st_size / 1e6:.1f} MB", flush=True)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--mode", choices=("keyframes", "full", "chunk", "assemble", "audio"), required=True)
    p.add_argument("--work", default="/content/pwx")
    p.add_argument("--out", default="")
    p.add_argument("--samples", type=int, default=64)
    p.add_argument("--scale", type=int, default=100)
    p.add_argument("--times", default="", help="keyframes mode: comma-separated seconds")
    p.add_argument("--range", default="", help="chunk mode: first:last frame")
    p.add_argument("--skip-render", action="store_true")
    p.add_argument("--beauty", default="", help="reuse this folder of beauty frames")
    a = p.parse_args()
    work = Path(a.work)
    out = Path(a.out) if a.out else work / "out"
    out.mkdir(parents=True, exist_ok=True)
    audio = out / "pi-warden-3d-explainer.wav"
    if a.mode == "audio":
        synth_audio(audio)
        package(out, [audio.name], out / "audio.tar")
        return
    fonts = ensure_fonts(work)
    blender = ensure_blender(work) if a.mode != "assemble" else None
    beauty = Path(a.beauty) if a.beauty else work / f"beauty-{source_digest()}-s{a.samples}-x{a.scale}"
    print(f"beauty frames: {beauty}", flush=True)

    if a.mode == "keyframes":
        times = [float(v) for v in a.times.split(",")] if a.times else KEYFRAMES
        frames = [round(t * FPS) for t in times]
        if not a.skip_render:
            render_beauty(blender, fonts, beauty, frames=frames, samples=a.samples, scale=a.scale)
        stills = out / "keyframes"
        stills.mkdir(exist_ok=True)
        keep = {f: stills / f"kf-{i + 1:02d}-{t:05.2f}s.png" for i, (f, t) in enumerate(zip(frames, times))}
        grade_frames(beauty, frames, fonts, keep=keep)
        contact_sheet([(keep[f], t) for f, t in zip(frames, times)], out / "contact-sheet.png", fonts)
        package(out, ["contact-sheet.png", *[f"keyframes/{k.name}" for k in keep.values()]], out / "keyframes.tar")
        return

    if a.mode in ("full", "chunk"):
        first, last = (int(v) for v in a.range.split(":")) if a.range else (0, FRAME_COUNT - 1)
        frames = list(range(first, last + 1))
        if not a.skip_render:
            render_beauty(blender, fonts, beauty, frame_range=(first, last), samples=a.samples, scale=a.scale)
        finals = out / "final-frames"
        finals.mkdir(exist_ok=True)
        keep = {round(t * FPS): finals / f"final-{i + 1:02d}-{t:05.2f}s.png" for i, t in enumerate(KEYFRAMES)
                if first <= round(t * FPS) <= last}
        chunks = out / "chunks"
        chunks.mkdir(exist_ok=True)
        encode_video(beauty, frames, fonts, chunks / f"chunk-{first:05d}-{last:05d}.mp4", keep=keep)
        if a.mode == "chunk":
            package(out, [f"chunks/chunk-{first:05d}-{last:05d}.mp4", *[f"final-frames/{k.name}" for k in keep.values()]],
                    out / f"chunk-{first:05d}-{last:05d}.tar")
            return

    if a.mode == "full" or not audio.exists():
        synth_audio(audio)
    chunk_files = sorted((out / "chunks").glob("chunk-*.mp4"))
    listing = out / "chunks.txt"
    listing.write_text("".join(f"file '{c.resolve()}'\n" for c in chunk_files))
    mp4 = out / "pi-warden-3d-explainer-1080p60.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing), "-i", str(audio),
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", f"{AUDIO_KBPS}k", "-ar", str(SAMPLE_RATE),
                    "-t", f"{DURATION}", "-movflags", "+faststart", str(mp4)], check=True)
    print(f"film: {mp4.name} {mp4.stat().st_size / 1e6:.1f} MB from {len(chunk_files)} chunk(s)", flush=True)
    encode_web(mp4, out / "pi-warden-3d-explainer-github.mp4")
    make_gif(mp4, out / "pi-warden-3d-explainer-preview.gif")
    stills = sorted((out / "final-frames").glob("final-*.png"))
    contact_sheet([(s, float(s.stem.split("-")[-1][:-1])) for s in stills], out / "contact-sheet.png", fonts)
    package(out, ["pi-warden-3d-explainer-1080p60.mp4", "pi-warden-3d-explainer-github.mp4", "pi-warden-3d-explainer-preview.gif",
                  "contact-sheet.png",
                  "pi-warden-3d-explainer.wav", *[f"final-frames/{s.name}" for s in stills]], out / "film.tar")


if __name__ == "__main__":
    if "--blender" in sys.argv:
        blender_main(sys.argv[sys.argv.index("--") + 1:])
    else:
        main()
