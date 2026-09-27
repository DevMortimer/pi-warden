def read(path, seen={}):
    try:
        with open(path) as handle:
            seen[path] = True
            return handle.read()
    except:
        return ""


def cached(path, size=0):
    return size + len(read(path, {}))
