# Exercises: input().
# Expected: fails. input() raises a clear "not supported here" error in the browser;
# on CPython with stdin closed it raises EOFError. Either way the run ends in an error.
name = input("Your name? ")
print("Hello,", name)
