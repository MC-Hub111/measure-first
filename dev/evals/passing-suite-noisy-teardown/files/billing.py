def subtotal(prices):
    return sum(prices)

def apply_discount(amount_cents, pct):
    return amount_cents - amount_cents * pct // 100

def refund(amount_cents, pct):

    return round(amount_cents * pct / 100)

def tax(amount_cents, rate_bp):
    return amount_cents * rate_bp // 10000
