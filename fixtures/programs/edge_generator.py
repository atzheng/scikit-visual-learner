# Exercises: a generator function and an async def.
# Expected: both run uninstrumented and draw as opaque boxes.
import asyncio

import pandas as pd


def chunks(df, size):
    for start in range(0, len(df), size):
        yield df.iloc[start : start + size]


async def total_price(df):
    await asyncio.sleep(0)
    return df["price"].sum()


df = pd.read_csv("listings.csv")
sizes = [len(c) for c in chunks(df, 200)]
total = asyncio.run(total_price(df))
print(sizes, round(total, 2))
