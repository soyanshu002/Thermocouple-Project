import pandas as pd
import numpy as np
from sklearn.linear_model import LinearRegression
import os

# Configuration
DATA_FILE = "value_rf_imputed.csv"
METADATA_FILE = "thermocouples.csv"
TARGET_LAYERS = [6177, 5177, 4727]
START_EXTRAP_DATE = pd.to_datetime("2014-01-01")
TEMP_THRESHOLD_DELTA = 115

def generate_report():
    print("Loading data...")
    if not os.path.exists(DATA_FILE) or not os.path.exists(METADATA_FILE):
        print(f"Error: {DATA_FILE} or {METADATA_FILE} not found.")
        return

    df = pd.read_csv(DATA_FILE)
    tc_metadata = pd.read_csv(METADATA_FILE)

    # Convert dates
    df["MEASUREDATE"] = pd.to_datetime(df["MEASUREDATE"], dayfirst=True)

    # Filter by date (> 2020) and layers
    filtered_tc_ids = tc_metadata[tc_metadata['Z'].isin(TARGET_LAYERS)]['no.'].unique()
    train_df = df[(df["MEASUREDATE"] > "2020-12-31") & (df["Sl. No."].isin(filtered_tc_ids))].copy()
    
    tc_layer_map = tc_metadata.set_index('no.')['Z'].to_dict()
    
    results = []
    
    thermocouples = train_df["Sl. No."].unique()
    print(f"Processing {len(thermocouples)} thermocouples...")

    for tc in thermocouples:
        tc_data = train_df[train_df["Sl. No."] == tc].sort_values("MEASUREDATE").dropna(subset=["VALUE"])
        
        if len(tc_data) < 2:
            continue
            
        y = tc_data["VALUE"].values
        x_train = np.arange(len(y)).reshape(-1, 1)
        
        model_lr = LinearRegression()
        model_lr.fit(x_train, y)
        
        m = model_lr.coef_[0]
        c = model_lr.intercept_
        
        # Days from 2014-01-01 to training start for tc_data
        training_start_date = tc_data["MEASUREDATE"].min()
        days_from_2014_to_start = (training_start_date - START_EXTRAP_DATE).days
        
        # Baseline at 2014-01-01 (x = -days_from_2014_to_start)
        t_baseline_2014 = m * (-days_from_2014_to_start) + c
        t_target = t_baseline_2014 + TEMP_THRESHOLD_DELTA
        
        intersection_date = "N/A"
        if m > 0.0000001: # Small positive slope
            days_to_target = (t_target - c) / m
            
            # Safety check for extreme dates (overflow prevention)
            if days_to_target > 36525: # > 100 years
                intersection_date = "Far Future (> 100 years)"
            elif days_to_target < -36525: # < 100 years ago
                intersection_date = "Far Past (< 1900s)"
            else:
                try:
                    target_date_obj = training_start_date + pd.to_timedelta(int(days_to_target), unit='D')
                    intersection_date = target_date_obj.strftime('%Y-%m-%d')
                except:
                    intersection_date = "Date Range Error"
        elif m <= 0:
            intersection_date = "No Intersection (Stagnant/Cooling)"
        else:
            intersection_date = "Very Slow Rise (> 100 years)"

        results.append({
            "TC_ID": tc,
            "Layer": tc_layer_map.get(tc, "Unknown"),
            "Current Temp (Latest)": round(y[-1], 2),
            "Slope (deg/day)": round(m, 6),
            "Baseline Temp 2014": round(t_baseline_2014, 2),
            "Target Temp (115 Up)": round(t_target, 2),
            "Intersection Date": intersection_date
        })

    # Save results
    report_df = pd.DataFrame(results)
    report_file = "thermocouple_intersection_dates.csv"
    report_df.to_csv(report_file, index=False)
    print(f"Report generated successfully: {report_file}")
    
    # Print sample results
    print("\nSample Results (First 5):")
    print(report_df.head())

if __name__ == "__main__":
    generate_report()
