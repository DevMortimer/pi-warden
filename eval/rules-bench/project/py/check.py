def all_positive(values):
    return any(value > 0 for value in values)


def negatives(values):
    return [value for value in values if value < 0]
