import pandas as pd
import os

file_path = r"g:\Other computers\My Laptop\Documents\Thermocouple Project\thermocouple_data_fixed.csv"
outfile = r"g:\Other computers\My Laptop\Documents\Thermocouple Project\thermocouple_data_fixed_v2.csv"

if not os.path.exists(file_path):
    print(f"File not found: {file_path}")
    exit()

df = pd.read_csv(file_path)
df['MEASUREDATE'] = pd.to_datetime(df['MEASUREDATE'])

def swap_date_if_possible(d):
    if d.year != 2025:
        return d
    
    # Check identifying ambiguity
    # User said "alternate months and days"
    # We can only alternate if Day <= 12 (to become Month) and Month <= 12 (to become Day, which is always true)
    
    if d.day <= 12:
        try:
            new_date = pd.Timestamp(year=d.year, month=d.day, day=d.month)
            return new_date
        except:
            return d
    else:
        # Day > 12, cannot be a month. Keep as is.
        return d

# Apply correction
df['MEASUREDATE'] = df['MEASUREDATE'].apply(swap_date_if_possible)

# Save string format
df['MEASUREDATE'] = df['MEASUREDATE'].dt.strftime('%Y-%m-%d')

df.to_csv(outfile, index=False)
print(f"Corrected 2025 dates in {outfile}")
