"""Generate the synthetic listings datasets (seeded, deterministic).

Run from the repo root:  uv run python fixtures/data/make_listings.py
Writes listings.csv (500 rows) and listings_10k.csv (10,000 rows) next to this file.
"""

from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
NEIGHBOURHOODS = {
    "Downtown": 1.35,
    "Midtown": 1.15,
    "Uptown": 1.0,
    "Riverside": 0.9,
    "Old Town": 0.85,
    "Suburbs": 0.7,
}
ROOM_TYPES = {"entire_home": 1.0, "private_room": 0.55, "shared_room": 0.3}


def make_listings(n: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    beds = rng.choice([1, 2, 3, 4, 5], size=n, p=[0.3, 0.35, 0.2, 0.1, 0.05])
    baths = np.clip(beds - rng.integers(0, 2, size=n), 1, None) + rng.choice([0, 0.5], size=n)
    sqft = np.round(350 + 300 * beds + rng.normal(0, 120, size=n)).clip(250)
    hood = rng.choice(list(NEIGHBOURHOODS), size=n)
    room = rng.choice(list(ROOM_TYPES), size=n, p=[0.6, 0.3, 0.1])
    year = rng.integers(1920, 2023, size=n).astype(float)
    hood_f = np.array([NEIGHBOURHOODS[h] for h in hood])
    room_f = np.array([ROOM_TYPES[r] for r in room])
    price = (
        (40 + 0.12 * sqft + 18 * baths + 6 * beds + 0.4 * (year - 1920))
        * hood_f
        * room_f
        * rng.lognormal(0, 0.08, size=n)
    )
    df = pd.DataFrame(
        {
            "beds": beds,
            "baths": baths,
            "sqft": sqft,
            "neighbourhood": hood,
            "room_type": room,
            "year_built": year,
            "price": np.round(price, 2),
        }
    )
    for col in ("sqft", "year_built"):
        df.loc[rng.random(n) < 0.03, col] = np.nan
    return df


def main() -> None:
    for name, n, seed in (("listings.csv", 500, 20240), ("listings_10k.csv", 10_000, 20241)):
        make_listings(n, seed).to_csv(HERE / name, index=False)


if __name__ == "__main__":
    main()
