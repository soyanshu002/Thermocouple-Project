import pandas as pd
import json
import os

# Paths
INPUT_CSV = r'g:\Other computers\My Laptop\Documents\Thermocouple Project\thermocouple_data_final.csv'
OUTPUT_JSON = r'g:\Other computers\My Laptop\Documents\Thermocouple Project\visualization\temperatures.json'

def main():
    print(f"Reading data from {INPUT_CSV}...")
    try:
        df = pd.read_csv(INPUT_CSV)
    except FileNotFoundError:
        print(f"Error: File not found at {INPUT_CSV}")
        return

    # Expected columns based on notebook analysis: 'Sl No.', 'MEASUREDATE', 'VALUE'
    # Check if we need to rename or if they exist
    print("Columns:", df.columns.tolist())
    
    # Standardize column names
    if 'Sl No.' in df.columns:
        df.rename(columns={'Sl No.': 'TC_ID'}, inplace=True)
    if 'MEASUREDATE' in df.columns:
        df.rename(columns={'MEASUREDATE': 'Date'}, inplace=True)
    if 'VALUE' in df.columns:
        df.rename(columns={'VALUE': 'Temp'}, inplace=True)

    # Parse Dates
    # The file is known to use %d/%m/%Y
    df['Date'] = pd.to_datetime(df['Date'], format='%d/%m/%Y', errors='coerce')
    
    # Drop rows with invalid keys
    df = df.dropna(subset=['Date', 'TC_ID', 'Temp'])
    
    # Format Date as DD-MM-YYYY for the visualization script
    df['DateStr'] = df['Date'].dt.strftime('%d-%m-%Y')
    
    # Ensure TC_ID is integer then string to remove leading zeros (e.g. 001 -> 1)
    # This matches the logic in script.js: parseInt(tcId).toString()
    df['TC_ID'] = df['TC_ID'].astype(int).astype(str)
    
    # Structure the data
    # { "DD-MM-YYYY": { "1": 50.5, "2": ... } }
    
    output_data = {}
    
    print("Grouping data...")
    # Group by DateStr
    grouped = df.groupby('DateStr')
    
    for date_str, group in grouped:
        # Create dictionary for this date: ID -> Temp
        # avg if duplicates exist
        daily_temps = group.groupby('TC_ID')['Temp'].mean().to_dict()
        output_data[date_str] = daily_temps
        
    # Write to JSON
    print(f"Writing {len(output_data)} dates to {OUTPUT_JSON}...")
    with open(OUTPUT_JSON, 'w') as f:
        json.dump(output_data, f, indent=None) # Minified for size, or indent=4 for read
    
    print("Done!")

if __name__ == "__main__":
    main()
