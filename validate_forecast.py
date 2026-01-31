
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error
import os

def process_data(df, target_tc_id):
    # Standardize columns
    # Assuming df has 'TC_ID', 'Date', 'Temp' after initial cleanup
    df['Date'] = pd.to_datetime(df['Date'], dayfirst=True, errors='coerce')
    df = df.dropna(subset=['Date', 'Temp'])
    df = df.sort_values('Date')
    
    # Filter for target TC
    df = df[df['TC_ID'] == target_tc_id].copy()
    
    return df

def feature_engineering(df):
    df['Year'] = df['Date'].dt.year
    df['Month'] = df['Date'].dt.month
    df['DayOfYear'] = df['Date'].dt.dayofyear
    df['DaysIndex'] = (df['Date'] - df['Date'].min()).dt.total_seconds() / (3600*24)
    return df

def main():
    TARGET_TC_ID = 102
    TRAIN_FILE = 'thermocouple_data_cleaned.csv'
    VAL_FILE = 'New_6M_Dataset.xlsx'
    
    print(f"--- Validating Forecast for TC {TARGET_TC_ID} ---")
    
    # 1. Load Training Data
    if not os.path.exists(TRAIN_FILE):
        print(f"Error: {TRAIN_FILE} not found.")
        return

    print("Loading training data...")
    # Inspecting train file columns might be needed if they differ, but assuming standard names
    # Based on file name 'thermocouple_data_cleaned.csv'
    try:
        train_df = pd.read_csv(TRAIN_FILE)
        # Rename based on inspected columns: ['Sl No.', 'MEASUREDATE', 'VALUE']
        train_df.rename(columns={
            'Sl No.': 'TC_ID', 
            'MEASUREDATE': 'Date', 
            'VALUE': 'Temp'
        }, inplace=True)
             
        # Ensure TC_ID is int
        if train_df['TC_ID'].dtype == object:
             train_df['TC_ID'] = train_df['TC_ID'].astype(str).str.extract(r'(\d+)').astype(int)

    except Exception as e:
        print(f"Error loading train data: {e}")
        return

    train_df = process_data(train_df, TARGET_TC_ID)
    train_df = feature_engineering(train_df)
    
    X_train = train_df[['Year', 'Month', 'DayOfYear', 'DaysIndex']]
    y_train = train_df['Temp']
    
    print(f"Training Model on {len(train_df)} records...")
    model = Ridge()
    model.fit(X_train, y_train)
    
    # 2. Load Validation Data (Memory Efficient)
    print("Loading validation data (Iterative Filtering)...")
    xl = pd.ExcelFile(VAL_FILE)
    cols = ['TAGID', 'MEASUREDATE', 'VALUE']
    
    val_dfs = []
    
    # helper to process chunks
    def process_sheet_df(df_chunk):
        # Ensure only 3 columns
        df_chunk = df_chunk.iloc[:, :3]
        df_chunk.columns = cols
        
        # Extract TC_ID
        # Handle potential non-numeric tags
        df_chunk['TC_ID'] = pd.to_numeric(df_chunk['TAGID'].astype(str).str[-3:], errors='coerce')
        
        # Filter immediately
        filtered = df_chunk[df_chunk['TC_ID'] == TARGET_TC_ID].copy()
        
        # Cleanup
        del df_chunk
        return filtered

    # Load Sheet 0 (with headers)
    print(f"Processing {xl.sheet_names[0]}...")
    df_main = xl.parse(xl.sheet_names[0])
    # Sheet 0 has headers, so we rename/align
    df_main.rename(columns={'TAGID': 'TAGID', 'MEASUREDATE': 'MEASUREDATE', 'VALUE': 'VALUE'}, inplace=True) # Redundant but safe
    val_dfs.append(process_sheet_df(df_main))
    
    # Load other sheets
    for sheet in xl.sheet_names[1:]:
        if sheet == 'SQL': continue
        print(f"Processing {sheet}...")
        try:
            # Header=None for subsequent sheets
            df_part = xl.parse(sheet, header=None)
            if not df_part.empty:
                val_dfs.append(process_sheet_df(df_part))
        except Exception as e:
            print(f"Skipping {sheet}: {e}")
            
    if not val_dfs:
        print("No data found for target TC.")
        return

    val_df = pd.concat(val_dfs, ignore_index=True)
    val_df = val_df.rename(columns={'MEASUREDATE': 'Date', 'VALUE': 'Temp'})
    
    # Process Dates
    val_df['Date'] = pd.to_datetime(val_df['Date'], dayfirst=True, errors='coerce')
    val_df = val_df.dropna(subset=['Date', 'Temp'])
    val_df = val_df.sort_values('Date')
    
    # Important: Feature Engineering must be consistent relative to the TRAINING start date?
    # Actually, DaysIndex depends on min date. 
    # If the model learned 'DaysIndex' starting from 0 at Train_Start, 
    # then for validation data, DaysIndex must be (Val_Date - Train_Start_Date).
    # We must preserve the training start date reference.
    
    TRAIN_START_DATE = train_df['Date'].min()
    
    val_df['Year'] = val_df['Date'].dt.year
    val_df['Month'] = val_df['Date'].dt.month
    val_df['DayOfYear'] = val_df['Date'].dt.dayofyear
    val_df['DaysIndex'] = (val_df['Date'] - TRAIN_START_DATE).dt.total_seconds() / (3600*24)
    
    X_val = val_df[['Year', 'Month', 'DayOfYear', 'DaysIndex']]
    y_val_actual = val_df['Temp']
    
    print(f"Predicting for validation period ({len(val_df)} records)...")
    y_val_pred = model.predict(X_val)
    
    # Metrics
    mae = mean_absolute_error(y_val_actual, y_val_pred)
    rmse = np.sqrt(mean_squared_error(y_val_actual, y_val_pred))
    
    print(f"\n--- Validation Results ---")
    print(f"MAE: {mae:.2f}")
    print(f"RMSE: {rmse:.2f}")
    
    # Plot
    plt.figure(figsize=(12, 6))
    plt.plot(val_df['Date'], y_val_actual, label='Actual (New Data)', alpha=0.7)
    plt.plot(val_df['Date'], y_val_pred, label='Predicted (Model)', alpha=0.7, linestyle='--')
    plt.title(f"Forecast Validation for TC {TARGET_TC_ID}")
    plt.xlabel("Date")
    plt.ylabel("Temperature")
    plt.legend()
    plt.grid(True)
    plt.savefig('validation_result_plot.png')
    print("Plot saved to validation_result_plot.png")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        traceback.print_exc()
