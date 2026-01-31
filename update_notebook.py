
import json
import os

NOTEBOOK_PATH = 'forecasting.ipynb'

# The validation code snippets to add
# We'll split them into logical cells

markdown_cell_1 = {
 "cell_type": "markdown",
 "metadata": {},
 "source": [
  "# Forecast Validation with New 6-Month Dataset\n",
  "\n",
  "We will now validate our model using the newly provided 6-month dataset (`New_6M_Dataset.xlsx`).\n",
  "\n",
  "**Steps:**\n",
  "1. Load data from all sheets (Iterative loading for memory efficiency).\n",
  "2. Filter for Target Thermocouple (default TC 102).\n",
  "3. Align features (Date, DaysIndex) with training data.\n",
  "4. Predict and Compare."
 ]
}

code_cell_load = {
 "cell_type": "code",
 "execution_count": None,
 "metadata": {},
 "outputs": [],
 "source": [
  "# Validation Settings\n",
  "VAL_FILE = 'New_6M_Dataset.xlsx'\n",
  "TARGET_TC_ID = 102 # Ensure this matches the trained model's TC\n",
  "\n",
  "import pandas as pd\n",
  "import numpy as np\n",
  "import matplotlib.pyplot as plt\n",
  "from sklearn.metrics import mean_absolute_error, mean_squared_error\n",
  "\n",
  "# 1. Load Validation Data (Iterative/Memory Efficient)\n",
  "print(\"Loading validation data (Iterative Filtering)...\")\n",
  "xl = pd.ExcelFile(VAL_FILE)\n",
  "cols = ['TAGID', 'MEASUREDATE', 'VALUE']\n",
  "val_dfs = []\n",
  "\n",
  "def process_sheet_df(df_chunk, target_id):\n",
  "    # Ensure only 3 columns\n",
  "    df_chunk = df_chunk.iloc[:, :3]\n",
  "    df_chunk.columns = cols\n",
  "    # Extract TC_ID (last 3 chars)\n",
  "    df_chunk['TC_ID'] = pd.to_numeric(df_chunk['TAGID'].astype(str).str[-3:], errors='coerce')\n",
  "    # Filter\n",
  "    filtered = df_chunk[df_chunk['TC_ID'] == target_id].copy()\n",
  "    return filtered\n",
  "\n",
  "# Process Sheet 0 (Headers exist)\n",
  "print(f\"Processing {xl.sheet_names[0]}...\")\n",
  "df_main = xl.parse(xl.sheet_names[0])\n",
  "df_main.rename(columns={'TAGID': 'TAGID', 'MEASUREDATE': 'MEASUREDATE', 'VALUE': 'VALUE'}, inplace=True)\n",
  "val_dfs.append(process_sheet_df(df_main, TARGET_TC_ID))\n",
  "\n",
  "# Process other sheets (No headers)\n",
  "for sheet in xl.sheet_names[1:]:\n",
  "    if sheet == 'SQL': continue\n",
  "    print(f\"Processing {sheet}...\")\n",
  "    try:\n",
  "        df_part = xl.parse(sheet, header=None)\n",
  "        if not df_part.empty:\n",
  "            val_dfs.append(process_sheet_df(df_part, TARGET_TC_ID))\n",
  "    except Exception as e:\n",
  "        print(f\"Skipping {sheet}: {e}\")\n",
  "\n",
  "if val_dfs:\n",
  "    val_df = pd.concat(val_dfs, ignore_index=True)\n",
  "    val_df = val_df.rename(columns={'MEASUREDATE': 'Date', 'VALUE': 'Temp'})\n",
  "    val_df['Date'] = pd.to_datetime(val_df['Date'], dayfirst=True, errors='coerce')\n",
  "    val_df = val_df.dropna(subset=['Date', 'Temp'])\n",
  "    val_df = val_df.sort_values('Date')\n",
  "    print(f\"Validation Data Loaded: {len(val_df)} records for TC {TARGET_TC_ID}\")\n",
  "else:\n",
  "    print(\"No data found for target TC.\")"
 ]
}

code_cell_process = {
 "cell_type": "code",
 "execution_count": None,
 "metadata": {},
 "outputs": [],
 "source": [
  "# 2. Feature Engineering\n",
  "# Note: DaysIndex must be relative to the original Training Start Date\n",
  "# We assume 'df' (the training dataframe) is available from previous cells\n",
  "\n",
  "if 'df' in locals():\n",
  "    TRAIN_START_DATE = df['Date'].min()\n",
  "else:\n",
  "    # Fallback if df not in memory, assuming start of 2016 or derive from val_df (risky)\n",
  "    print(\"Warning: Training 'df' not found. Using Validation start as reference (may cause offset).\")\n",
  "    TRAIN_START_DATE = val_df['Date'].min()\n",
  "\n",
  "val_df['Year'] = val_df['Date'].dt.year\n",
  "val_df['Month'] = val_df['Date'].dt.month\n",
  "val_df['DayOfYear'] = val_df['Date'].dt.dayofyear\n",
  "val_df['DaysIndex'] = (val_df['Date'] - TRAIN_START_DATE).dt.total_seconds() / (3600*24)\n",
  "\n",
  "X_val = val_df[['Year', 'Month', 'DayOfYear', 'DaysIndex']]\n",
  "y_val_actual = val_df['Temp']"
 ]
}

code_cell_predict = {
 "cell_type": "code",
 "execution_count": None,
 "metadata": {},
 "outputs": [],
 "source": [
  "# 3. Predict & Evaluate\n",
  "# using 'best_model' from previous cells\n",
  "\n",
  "if 'best_model' in locals():\n",
  "    y_val_pred = best_model.predict(X_val)\n",
  "    \n",
  "    mae_val = mean_absolute_error(y_val_actual, y_val_pred)\n",
  "    rmse_val = np.sqrt(mean_squared_error(y_val_actual, y_val_pred))\n",
  "    \n",
  "    print(\"--- Validation Results on New 6M Data ---\")\n",
  "    print(f\"MAE: {mae_val:.2f}\")\n",
  "    print(f\"RMSE: {rmse_val:.2f}\")\n",
  "    \n",
  "    # Plot\n",
  "    plt.figure(figsize=(15, 6))\n",
  "    plt.plot(val_df['Date'], y_val_actual, label='Actual (New Data)', alpha=0.6, color='black')\n",
  "    plt.plot(val_df['Date'], y_val_pred, label='Forecast (Best Model)', alpha=0.7, linestyle='--', color='red')\n",
  "    plt.title(f\"Forecast Validation for TC {TARGET_TC_ID}\")\n",
  "    plt.xlabel(\"Date\")\n",
  "    plt.ylabel(\"Temperature\")\n",
  "    plt.legend()\n",
  "    plt.grid(True)\n",
  "    plt.show()\n",
  "else:\n",
  "    print(\"Error: 'best_model' not found. Please run the training cells above first.\")"
 ]
}

def update_notebook():
    try:
        with open(NOTEBOOK_PATH, 'r', encoding='utf-8') as f:
            nb = json.load(f)
        
        # Check if validation already added to avoid duplicates\n",
        # Simple check: see if "New 6-Month Dataset" string is in any source
        already_present = any("New 6-Month Dataset" in "".join(cell.get('source', [])) for cell in nb['cells'])
        
        if already_present:
            print("Notebook already contains validation section. Skipping.")
            return

        # Append new cells
        nb['cells'].append(markdown_cell_1)
        nb['cells'].append(code_cell_load)
        nb['cells'].append(code_cell_process)
        nb['cells'].append(code_cell_predict)
        
        with open(NOTEBOOK_PATH, 'w', encoding='utf-8') as f:
            json.dump(nb, f, indent=1)
            
        print(f"Successfully updated {NOTEBOOK_PATH} with validation cells.")
        
    except Exception as e:
        print(f"Error updating notebook: {e}")

if __name__ == "__main__":
    update_notebook()
