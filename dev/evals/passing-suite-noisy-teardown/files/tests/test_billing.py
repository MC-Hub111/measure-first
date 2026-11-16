from billing import subtotal, apply_discount, refund, tax

def test_subtotal_empty():
    assert subtotal([]) == 0

def test_subtotal_sums():
    assert subtotal([100, 250, 5]) == 355

def test_discount_ten_percent():
    assert apply_discount(1000, 10) == 900

def test_refund_half():
    assert refund(1000, 50) == 500

def test_refund_rounding():
    assert refund(999, 33.3) == 333

def test_tax_basis_points():
    assert tax(10000, 825) == 825
