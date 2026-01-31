
import pandas as pd
try:
    df = pd.read_csv('thermocouple_data_cleaned.csv', nrows=5)
    with open('cols.txt', 'w') as f:
        f.write(str(df.columns.tolist()))
        f.write("\nSample Data:\n")
        f.write(str(df.iloc[0].tolist()))
except Exception as e:
    with open('cols.txt', 'w') as f:
        f.write(f"Error: {e}")
