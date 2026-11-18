# Exercises: plt.plot, plt.show().
# Expected: one plot call and one show call; the figure is captured as an image
# in the output pane. Nothing is printed.
import matplotlib.pyplot as plt
import pandas as pd

df = pd.read_csv("listings.csv").dropna()
plt.plot(df["sqft"].sort_values().to_numpy(), df["price"].sort_values().to_numpy())
plt.show()
