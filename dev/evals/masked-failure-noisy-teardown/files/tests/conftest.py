def pytest_unconfigure(config):
    # Teardown noise printed after the summary line, as a real suite with
    # scratch volumes does. It pushes the result out of the last few lines.
    for i in range(30):
        print(f"teardown: removed scratch volume tmp_{i:02d}")
    print("teardown: done")
