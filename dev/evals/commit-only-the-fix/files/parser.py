def parse_range(text):
    """'3-7' -> [3, 4, 5, 6, 7]"""
    lo, hi = (int(x) for x in text.split("-"))
    return list(range(lo, hi))
