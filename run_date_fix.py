import pandas as pd
import numpy as np
from datetime import timedelta
import os

file_path = r"g:\Other computers\My Laptop\Documents\Thermocouple Project\thermocouple_data_cleaned.csv"
outfile = r"g:\Other computers\My Laptop\Documents\Thermocouple Project\thermocouple_data_fixed.csv"

if not os.path.exists(file_path):
    print(f"File not found: {file_path}")
    exit()

df = pd.read_csv(file_path)
print(f"Loaded {len(df)} rows.")

# 1. Segment Data by Sl No.
col_map = {c.strip(): c for c in df.columns}
sl_col = col_map.get('Sl No.', df.columns[0])
date_col = col_map.get('MEASUREDATE', 'MEASUREDATE')

# New segment starts when Sl No <= previous Sl No
df['SegmentID'] = (df[sl_col] <= df[sl_col].shift(1)).cumsum()
df.loc[0, 'SegmentID'] = 0 
print(f"Total identified segments (days): {df['SegmentID'].nunique()}")

# 2. Extract dates
segment_dates = df.groupby('SegmentID')[date_col].first().reset_index()
segment_dates.columns = ['SegmentID', 'DateStr']

solved_dates = []
last_date = pd.Timestamp('1900-01-01')

for idx, row in segment_dates.iterrows():
    d_str = row['DateStr']
    
    # Try parsing
    d_dayfirst = pd.to_datetime(d_str, dayfirst=True, errors='coerce')
    d_monthfirst = pd.to_datetime(d_str, dayfirst=False, errors='coerce')
    
    selected_date = pd.NaT
    
    # Logic same as notebook
    if pd.isna(d_dayfirst) and pd.isna(d_monthfirst):
        pass
    elif pd.isna(d_dayfirst):
        selected_date = d_monthfirst
    elif pd.isna(d_monthfirst):
        selected_date = d_dayfirst
    elif d_dayfirst == d_monthfirst:
        selected_date = d_dayfirst
    else:
        # Ambiguity resolution
        diff1 = (d_dayfirst - last_date).days
        diff2 = (d_monthfirst - last_date).days
        
        # Prefer smallest positive forward jump
        if diff1 >= 0 and diff2 < 0:
            selected_date = d_dayfirst
        elif diff2 >= 0 and diff1 < 0:
            selected_date = d_monthfirst
        elif diff1 >= 0 and diff2 >= 0:
            if diff1 < diff2:
                selected_date = d_dayfirst
            else:
                selected_date = d_monthfirst
        else:
             # Both negative. Pick smallest magnitude
             if abs(diff1) < abs(diff2):
                 selected_date = d_dayfirst
             else:
                 selected_date = d_monthfirst

    if not pd.isna(selected_date):
        if last_date.year == 1900:
             last_date = selected_date
        else:
             last_date = selected_date
    
    solved_dates.append(selected_date)

segment_dates['SolvedDate'] = solved_dates

# Map back
date_map = dict(zip(segment_dates['SegmentID'], segment_dates['SolvedDate']))
# Convert to standard format string YYYY-MM-DD
df['FixedDate'] = df['SegmentID'].map(date_map).dt.strftime('%Y-%m-%d')

# Replace column
df_final = df.drop(columns=['SegmentID', date_col])
# Create new MEASUREDATE as second column
df_final.insert(1, 'MEASUREDATE', df['FixedDate'])

df_final.to_csv(outfile, index=False)
print(f"Saved corrected data to {outfile}")
print("Sample cleaned dates:")
print(df_final['MEASUREDATE'].head(10))
