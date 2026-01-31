import pandas as pd
import os

file_path = r"g:\Other computers\My Laptop\Documents\Thermocouple Project\thermocouple_data_cleaned.csv"

if not os.path.exists(file_path):
    print(f"File not found: {file_path}")
    exit()

try:
    df = pd.read_csv(file_path)
    print(f"Total rows: {len(df)}")
    print(f"Columns: {df.columns.tolist()}")

    # Check the 1-506 pattern
    # We expect Sl No. or similar to be the ID.
    # The user said "Sl No." 1-506. Let's find the column.
    
    col_map = {c.strip(): c for c in df.columns}
    sl_col = col_map.get('Sl No.', df.columns[0]) # Guess first column if exact match fails
    date_col = col_map.get('MEASUREDATE', 'MEASUREDATE')

    print(f"Using Sl No column: '{sl_col}'")
    print(f"Using Date column: '{date_col}'")

    if sl_col not in df.columns:
        print("Sl No. column not found!")
        print(df.head())
        exit()

    # Analyze blocks
    # A block ends when Sl No resets to 1? Or just every 506 rows?
    # Let's check the values of Sl No
    
    sl_values = df[sl_col].values
    
    # Check if every 506th value resets or enables block detection
    blocks = []
    current_block_start = 0
    
    # Simple check: divide rows by 506
    # Check if Sl No 1 matches indices 0, 506, 1012...
    
    mismatches = 0
    for i in range(0, len(df), 506):
        if i < len(df):
            val = df.iloc[i][sl_col]
            if val != 1:
                mismatches += 1
                if mismatches < 5:
                    print(f"Mismatch at row {i}: expected 1, got {val}")
    
    if mismatches == 0:
        print("Structure Confirmed: Every 506 rows starts with Sl No = 1 (checked sampled indices).")
    else:
        print(f"Structure Warning: Found {mismatches} block start mismatches. The pattern might not be strictly 506 rows.")

    # Analyze Dates per block
    # Group by block index (row // 506) and count unique date strings
    
    df['BlockID'] = df.index // 506
    
    block_dates = df.groupby('BlockID')[date_col].nunique()
    multi_date_blocks = block_dates[block_dates > 1]
    
    if not multi_date_blocks.empty:
        print(f"Warning: {len(multi_date_blocks)} blocks have multiple date strings within the same block!")
        print(multi_date_blocks.head())
    else:
        print("All blocks have a single unique date string per block. This is good.")

    # Analyze Date Ambiguity
    # Extract unique dates from the blocks
    # We want to see if we can establish a chronological sequence
    
    unique_block_dates = df.groupby('BlockID')[date_col].first()
    
    print("\nSample Block Dates (First 20):")
    print(unique_block_dates.head(20))
    
    # Try parsing manually to identify ambiguity
    # Ambiguous: Day <= 12 and Month <= 12, and Day != Month
    
    def check_ambiguity(d_str):
        try:
            # Assuming separators are / or -
            parts = str(d_str).replace('/', '-').split('-')
            if len(parts) != 3: return "FormatErr"
            # Assuming either first or second is year? usually year is last.
            # 29-03-2016 -> 29, 03, 2016.
            p1, p2, p3 = int(parts[0]), int(parts[1]), int(parts[2])
            
            if p1 > 12: # p1 must be Day. Schema: DD-MM-YYYY
                return "DD-MM-YYYY (Unambiguous)"
            elif p2 > 12: # p2 must be Day. Schema: MM-DD-YYYY
                return "MM-DD-YYYY (Unambiguous)"
            elif p1 == p2:
                 return "Symmetric (Unambiguous)"
            else:
                return "AMBIGUOUS"
        except:
            return "ParseErr"

    ambiguity_counts = unique_block_dates.apply(check_ambiguity).value_counts()
    print("\nAmbiguity Analysis of Block Dates:")
    print(ambiguity_counts)

except Exception as e:
    print(f"Error reading or processing CSV: {e}")
