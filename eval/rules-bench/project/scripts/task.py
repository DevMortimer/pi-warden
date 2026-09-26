def load(path):
    try:
        with open(path) as handle:
            return handle.read()
    except FileNotFoundError:
        return ""


def save(path, text):
    with open(path, "w") as handle:
        handle.write(text)
