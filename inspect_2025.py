import pandas as pd
import os

file_path = r"g:\Other computers\My Laptop\Documents\Thermocouple Project\thermocouple_data_fixed.csv"

if not os.path.exists(file_path):
    print(f"File not found: {file_path}")
    exit()

df = pd.read_csv(file_path)
df['MEASUREDATE'] = pd.to_datetime(df['MEASUREDATE'])

# Filter 2025
df_2025 = df[df['MEASUREDATE'].dt.year == 2025].copy()

if df_2025.empty:
    print("No 2025 data found.")
    exit()

unique_dates = df_2025['MEASUREDATE'].unique()
unique_dates = sorted(df_2025['MEASUREDATE'].unique())

print(f"Unique 2025 Dates ({len(unique_dates)}):")
for d in unique_dates:
    ts = pd.Timestamp(d)
    can_swap = ts.day <= 12
    print(f"{ts.strftime('%Y-%m-%d')} - Day: {ts.day}, Month: {ts.month} - Can Swap? {can_swap}")

# Check if any Cannot Swap
unswappable = [d for d in unique_dates if pd.Timestamp(d).day > 12]
if unswappable:
    print(f"\nWARNING: {len(unswappable)} dates cannot be swapped because Day > 12.")
else:
    print("\nAll 2025 dates can be swapped (Day <= 12).")
