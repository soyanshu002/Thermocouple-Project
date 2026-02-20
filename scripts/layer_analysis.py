import pandas as pd
import numpy as np
from datetime import datetime

# Configuration
THERMOCOUPLE_FILE = 'thermocouples.csv'
DATA_FILE = 'value_rf_imputed.csv'

def get_mode(x):
    # Mode for continuous data: standard mode might imply strict equality.
    # Rounding to nearest integer for meaningful mode in float data
    return x.round(0).mode().iloc[0] if not x.mode().empty else np.nan

def analyze_layers():
    print("Loading data...")
    # Load TC metadata
    try:
        tc_df = pd.read_csv(THERMOCOUPLE_FILE)
    except FileNotFoundError:
        print(f"Error: {THERMOCOUPLE_FILE} not found.")
        return

    # Count TCs per Z-layer
    print("\n--- Thermocouple Count per Layer (Z-coordinate) ---")
    layer_counts = tc_df.groupby('Z')['no.'].count().sort_index(ascending=False)
    print(layer_counts)
    
    # Save layer info for data merging
    # Map 'no.' (which matches 'Sl. No.') to 'Z'
    tc_z_map = tc_df[['no.', 'Z']].copy()
    tc_z_map['no.'] = tc_z_map['no.'].astype('int32')
    
    # Load Temperature Data
    print("Reading large data file...")
    try:
        # Load only necessary columns and specify types to save memory
        data_df = pd.read_csv(
            DATA_FILE, 
            usecols=['MEASUREDATE', 'Sl. No.', 'VALUE_rf_imputed'],
            dtype={'Sl. No.': 'int32', 'VALUE_rf_imputed': 'float32'}
        )
    except FileNotFoundError:
        print(f"Error: {DATA_FILE} not found.")
        return

    # Process Dates to get Year
    try:
        data_df['Date'] = pd.to_datetime(data_df['MEASUREDATE'], format='%d-%m-%Y')
    except:
        data_df['Date'] = pd.to_datetime(data_df['MEASUREDATE'])
        
    data_df['Year'] = data_df['Date'].dt.year
    
    # Merge Z coordinate into data
    # data_df has 'Sl. No.', tc_df has 'no.'
    merged_df = data_df.merge(tc_z_map, left_on='Sl. No.', right_on='no.', how='left')
    
    # Drop rows where Z is NaN (if any TC mismatch)
    merged_df = merged_df.dropna(subset=['Z'])
    
    print("\n--- Layer-wise Year-wise Statistics ---")
    print("Calculating statistics (Max, Min, Avg, Mode)... this might take a moment.")
    
    # Group by Z and Year
    # Aggregations: min, max, mean. 
    # 'count' here is number of readings. We'll rename it later.
    # Also want unique TCs active in that year
    stats = merged_df.groupby(['Z', 'Year']).agg({
        'VALUE_rf_imputed': ['min', 'max', 'mean', 'count'],
        'Sl. No.': 'nunique'
    })
    
    # Flatten columns
    stats.columns = ['min_temp', 'max_temp', 'avg_temp', 'readings_count', 'active_tcs_count']
    
    # Add Total TCs per layer (Static)
    # layer_counts is Series: Z -> count
    # Join based on Z index level
    stats = stats.reset_index().merge(layer_counts.rename('total_tcs_installed'), on='Z', how='left').set_index(['Z', 'Year'])
    
    # Calculate Mode separately or iterate? 
    # Iterating might be safer/clearer for custom mode logic on large data
    # Or apply custom lambda (slower)
    # Let's try apply with rounded mode
    modes = merged_df.groupby(['Z', 'Year'])['VALUE_rf_imputed'].apply(get_mode)
    modes.name = 'mode (approx)'
    
    # Join
    final_stats = stats.join(modes)
    
    # Formatting
    pd.set_option('display.max_rows', None)
    pd.set_option('display.float_format', '{:.2f}'.format)
    
    print(final_stats)
    
    # Optional: Save to CSV
    output_file = 'layer_statistics.csv'
    final_stats.to_csv(output_file)
    print(f"\nDetailed statistics saved to {output_file}")

if __name__ == "__main__":
    analyze_layers()
