import json


def parse(path, options=None):
    if options is None:
        options = {}
    with open(path) as handle:
        data = json.load(handle)
    return data.get(options.get("key", "items"), [])


def main(path):
    try:
        items = parse(path)
    except FileNotFoundError as error:
        return [f"missing file: {error}"]
    return items
