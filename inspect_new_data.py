
import pandas as pd
import sys

with open('inspection_result.txt', 'w', encoding='utf-8') as f:
    try:
        xl = pd.ExcelFile('New_6M_Dataset.xlsx')
        f.write(f"Sheet Names: {xl.sheet_names}\n")
        
        for i, sheet in enumerate(xl.sheet_names):
            f.write(f"\n--- Sheet {i}: {repr(sheet)} ---\n")
            try:
                df = xl.parse(sheet, nrows=5)
                f.write(f"Columns: {df.columns.tolist()}\n")
                if not df.empty:
                    f.write(f"First row: {df.iloc[0].tolist()}\n")
                else:
                    f.write("Sheet is empty or has only headers.\n")
            except Exception as e:
                f.write(f"Error reading sheet: {e}\n")
            
    except Exception as e:
        f.write(f"Error opening file: {e}\n")
