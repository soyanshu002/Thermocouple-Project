import pandas as pd
import numpy as np
import json
import os
from datetime import datetime, timedelta
from sklearn.linear_model import LinearRegression
from statsmodels.tsa.arima.model import ARIMA
import warnings
warnings.filterwarnings("ignore") # Suppress ARIMA warnings for clean output

# Configuration
# Configuration
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

THERMOCOUPLE_FILE = os.path.join(PROJECT_ROOT, 'thermocouples.csv')
DATA_FILE = os.path.join(PROJECT_ROOT, 'value_rf_imputed.csv')
OUTPUT_JSON = os.path.join(PROJECT_ROOT, 'visualization', 'temperatures.json')
CRITICAL_TEMP = 600          
Z_LEVELS_OF_INTEREST = [6637, 6177, 5777]  # Topmost Bottom Layer, Warning, Critical

def predict_metric(daily, critical_temp):
    # Helper to predict based on a already aggregated daily metric
    # daily has columns 'Date' and 'VALUE_rf_imputed'
    daily = daily.sort_values('Date')
    
    # Check if already crossed
    crossings = daily[daily['VALUE_rf_imputed'] >= critical_temp]
    if not crossings.empty:
        first_cross = crossings.iloc[0]['Date']
        # Return dict with dates
        return {'status': 'failed', 'linear_date': first_cross, 'arima_date': first_cross, 'linear_slope': None}
    
    # Regression
    daily['date_ord'] = daily['Date'].map(datetime.toordinal)
    valid_data = daily[daily['VALUE_rf_imputed'] > 100]
    
    res = {'status': 'safe', 'linear_date': None, 'arima_date': None, 'linear_slope': None}
    
    if len(valid_data) < 30:
        res['status'] = 'insufficient_data'
        return res
        
    # 1. Linear Regression
    X = valid_data[['date_ord']]
    y = valid_data['VALUE_rf_imputed']
    
    model = LinearRegression()
    model.fit(X, y)
    slope = model.coef_[0]
    res['linear_slope'] = slope
    
    current_date = daily['Date'].max()
    current_temp = daily.iloc[-1]['VALUE_rf_imputed']
    
    if slope > 0.001:
        days_to_crit = (critical_temp - current_temp) / slope
        if days_to_crit > 0 and days_to_crit < 36500: # Cap at 100 years
            pred_date_ord = current_date.toordinal() + days_to_crit
            res['linear_date'] = datetime.fromordinal(int(pred_date_ord))

    # 2. ARIMA Forecast
    # We use the full daily series (even with noise) but maybe resample to Weekly to stabilize?
    # Weekly mean is cleaner for long-term ARIMA
    ts_data = daily.set_index('Date')['VALUE_rf_imputed'].resample('W').mean().dropna()
    
    if len(ts_data) > 20:
        try:
            # Simple ARIMA(1,1,1) is a good general starting point for trend+noise
            # Or (0,1,0) = Random Walk with Drift
            arima_model = ARIMA(ts_data, order=(5,1,0)) # Autoregressive
            arima_fit = arima_model.fit()
            
            # Forecast loop: predict ahead until crossing
            # Limit to 10 years (520 weeks)
            forecast_steps = 520 
            forecast = arima_fit.forecast(steps=forecast_steps)
            
            # Find crossing
            crossing_idx = (forecast >= critical_temp).idxmax() if (forecast >= critical_temp).any() else None
            
            if crossing_idx and forecast[crossing_idx] >= critical_temp:
                 # crossing_idx is a Timestamp if indexed, or int? statsmodels returns series with index
                 res['arima_date'] = crossing_idx
        except Exception as e:
            print(f"  [ARIMA Error] {e}")

    # Determine status
    if res['linear_date'] or res['arima_date']:
        res['status'] = 'predicted'
        
    return res


# Streaming implementation to avoid OOM
def predict_erosion_streaming(tc_df):
    print("\n--- Erosion Prediction Analysis (Streaming Aggregation) ---")
    print(f"Critical Temperature Threshold: {CRITICAL_TEMP} C")
    
    # 1. Prepare Mappings
    # TC ID (int) -> Z Level (int)
    # Filter only for Z levels of interest
    relevant_tcs = tc_df[tc_df['Z'].isin(Z_LEVELS_OF_INTEREST)]
    tc_z_map = relevant_tcs.set_index('no.')['Z'].to_dict()
    
    # 2. Initialize Aggregators
    # We need separate aggregators for Mean (Sum/Count) and Max (Max)
    # Structure: Dictionary of Date -> { z_level: { sum, count, max } } 
    # Or efficient DataFrame list? 
    # Let's use a list of small dataframes to concat later.
    
    agg_chunks = []
    
    print("Reading and aggregating data...")
    chunk_size = 50000 
    
    reader = pd.read_csv(
        DATA_FILE,
        usecols=['MEASUREDATE', 'Sl. No.', 'VALUE_rf_imputed'],
        dtype={'Sl. No.': 'int32', 'VALUE_rf_imputed': 'float32'},
        chunksize=chunk_size
    )
    
    for i, chunk in enumerate(reader):
        # Filter for relevant TCs
        chunk = chunk[chunk['Sl. No.'].isin(tc_z_map.keys())]
        
        if chunk.empty:
            continue
            
        # Map Sl. No. to Z
        chunk['Z'] = chunk['Sl. No.'].map(tc_z_map)
        
        # Parse Dates (Vectorized)
        try:
             chunk['Date'] = pd.to_datetime(chunk['MEASUREDATE'], format='%d-%m-%Y')
        except:
             chunk['Date'] = pd.to_datetime(chunk['MEASUREDATE'])
             
        # Group by Z and Date
        # Calculate Sum, Count, Max for this chunk
        chunk_agg = chunk.groupby(['Z', 'Date'])['VALUE_rf_imputed'].agg(['sum', 'count', 'max']).reset_index()
        
        agg_chunks.append(chunk_agg)
        
        if i % 10 == 0:
            print(f"  Processed chunk {i}...")

    if not agg_chunks:
        print("No valid data found.")
        return

    print("Finalizing aggregation...")
    # Concat all partial aggregations
    full_agg = pd.concat(agg_chunks, ignore_index=True)
    
    # Now group again by Z, Date to combine the partials
    # Sum of sums, Sum of counts, Max of maxes
    final_daily = full_agg.groupby(['Z', 'Date']).agg({
        'sum': 'sum',
        'count': 'sum',
        'max': 'max'
    }).reset_index()
    
    # Calculate global Mean
    final_daily['mean_temp'] = final_daily['sum'] / final_daily['count']
    final_daily['max_temp'] = final_daily['max']
    
    # 3. Analyze per Layer
    results = {'avg': {}, 'max': {}}
    
    for z_level in sorted(Z_LEVELS_OF_INTEREST, reverse=True):
        print(f"\nAnalyzing Layer Z={z_level}:")
        
        layer_daily = final_daily[final_daily['Z'] == z_level]
        
        if layer_daily.empty:
            print("  No data found.")
            continue
            
        # Prepare data for predict_metric helper
        # Helper expects columns 'Date' and 'VALUE_rf_imputed'
        
        # Linear/ARIMA for MEAN
        df_mean = layer_daily[['Date', 'mean_temp']].rename(columns={'mean_temp': 'VALUE_rf_imputed'})
        res_avg = predict_metric(df_mean, CRITICAL_TEMP) # Modified helper signature
        results['avg'][z_level] = res_avg
        print(f"  [Average Trend] Linear Date: {res_avg['linear_date']}, ARIMA Date: {res_avg['arima_date']}")

        # Linear/ARIMA for MAX
        df_max = layer_daily[['Date', 'max_temp']].rename(columns={'max_temp': 'VALUE_rf_imputed'})
        res_max = predict_metric(df_max, CRITICAL_TEMP) # Modified helper signature
        results['max'][z_level] = res_max
        print(f"  [Max/Safety Trend] Linear Date: {res_max['linear_date']}, ARIMA Date: {res_max['arima_date']}")

    # Summary Generation
    output_lines = []
    output_lines.append("\\n--- Prediction Summary ---")
    critical_layer = min(Z_LEVELS_OF_INTEREST) # Bottom-most
    
    nom_res = results['avg'].get(critical_layer)
    nom_lin = nom_res['linear_date'] if nom_res else None
    nom_arima = nom_res['arima_date'] if nom_res else None
    
    safe_res = results['max'].get(critical_layer)
    safe_lin = safe_res['linear_date'] if safe_res else None
    safe_arima = safe_res['arima_date'] if safe_res else None
    
    output_lines.append(f"ANALYSIS LAYER (Z={critical_layer})")
    
    def fmt_date(d): return d.strftime('%Y-%m-%d') if d else "Safe/Not Predicted"
    
    output_lines.append("\\nNOMINAL (Average Temp) PREDICTIONS:")
    output_lines.append(f"  Linear Regression: {fmt_date(nom_lin)}")
    output_lines.append(f"  ARIMA (TimeSeries): {fmt_date(nom_arima)}")
    
    output_lines.append("\\nSAFETY (Max Temp) PREDICTIONS:")
    output_lines.append(f"  Linear Regression: {fmt_date(safe_lin)}")
    output_lines.append(f"  ARIMA (TimeSeries): {fmt_date(safe_arima)}")
        
    final_msg = "\n".join(output_lines)
    print(final_msg)
    
    with open('prediction_summary.txt', 'w') as f:
        f.write(final_msg)


def update_json_streaming():
    print("\nGenerating visualization/temperatures.json (Streaming)...")
    
    # We need to build the full dict: { Date: { SlNo: Val } }
    # This might still be large in memory.
    # But we can build it chunk by chunk.
    
    output_data = {}
    
    # To handle duplicates efficiently without loading all:
    # Use a dictionary of dictionaries?
    # date -> { sl_no -> [values] } -> mean?
    # Or just overwrite?
    # The previous logic used Mean for duplicates.
    # Simplification: Assume duplicates are rare or overwrite is okay?
    # Or keep a running sum/count? Too complex for generic dict.
    # Let's rely on overwriting (Last wins) or just simple append if distinct.
    
    # Optimization: Use integers for intermediate keys to save space
    
    chunk_size = 500000
    reader = pd.read_csv(
        DATA_FILE,
        usecols=['MEASUREDATE', 'Sl. No.', 'VALUE_rf_imputed'],
        dtype={'Sl. No.': 'int32', 'VALUE_rf_imputed': 'float32'},
        chunksize=chunk_size
    )
    
    count = 0
    # Pre-structure: output_data[date_str] = { id_str: val }
    
    for chunk in reader:
        # Vectorized date parsing
        try:
             chunk['DateStr'] = pd.to_datetime(chunk['MEASUREDATE'], format='%d-%m-%Y').dt.strftime('%d-%m-%Y')
        except:
             chunk['DateStr'] = pd.to_datetime(chunk['MEASUREDATE']).dt.strftime('%d-%m-%Y')
        
        # We iterate rows or grouping?
        # Grouping by DateStr is faster
        grouped = chunk.groupby('DateStr')
        
        for date_str, group in grouped:
            if date_str not in output_data:
                output_data[date_str] = {}
            
            # Convert group to dict: SlNo -> Val
            # Assuming 'Sl. No.' is unique per date in this chunk
            # If not, duplicates within chunk are handled by overwriting
            
            # Using zip is fast
            # We must convert Sl. No. to string as per JSON req
            current_dict = dict(zip(group['Sl. No.'].astype(str), group['VALUE_rf_imputed']))
            
            # Update existing
            output_data[date_str].update(current_dict)
            
        count += len(chunk)
        if count % 1000000 == 0:
            print(f"  Processed {count} rows...")
            
    # Handle NaN/None? 
    # float32 has NaN. replace with None?
    # Doing it on the final dict is hard.
    # JSON dump handles NaN as NaN (invalid) or we need to customize.
    # Python json.dump produces NaN which is invalid JSON.
    # We must clean.
    
    # Cleaning pass
    print("Cleaning NaN values...")
    valid_count = 0
    for date, readings in output_data.items():
        for k, v in readings.items():
            if np.isnan(v):
                readings[k] = None
        valid_count += 1
        
    with open(OUTPUT_JSON, 'w') as f:
        json.dump(output_data, f)
        
    print(f"Successfully wrote records for {valid_count} dates to {OUTPUT_JSON}")

def main():
    tc_df = pd.read_csv(THERMOCOUPLE_FILE)
    predict_erosion_streaming(tc_df)
    update_json_streaming() # Enabled to update visualization data


if __name__ == "__main__":
    main()
