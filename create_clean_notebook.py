import json
import os

nb_content = {
 "cells": [
  {
   "cell_type": "markdown",
   "metadata": {},
   "source": [
    "# Thermocouple Data Date Cleaning\n",
    "\n",
    "This notebook fixes the ambiguous date formats in `thermocouple_data_cleaned.csv`.\n",
    "\n",
    "**Problem:** The `MEASUREDATE` column contains mixed formats (`dd/mm/yyyy` and `mm/dd/yyyy`).\n",
    "**Solution Strategy:**\n",
    "1. Identify data segments (days) using the `Sl No.` column (which resets to 1 for each new date/dataset).\n",
    "2. Extract one date string per segment.\n",
    "3. Use time-monotonicity to resolve ambiguities: The correct date interpretation should result in a forward-moving timeline without large backward jumps."
   ]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": [
    "import pandas as pd\n",
    "import numpy as np\n",
    "import matplotlib.pyplot as plt\n",
    "from datetime import timedelta\n",
    "\n",
    "file_path = 'thermocouple_data_cleaned.csv'\n",
    "df = pd.read_csv(file_path)\n",
    "\n",
    "print(f\"Loaded {len(df)} rows.\")\n",
    "df.head()"
   ]
  },
  {
   "cell_type": "markdown",
   "metadata": {},
   "source": [
    "## 1. Segment Data by `Sl No.`\n",
    "Every time `Sl No.` resets or drops (e.g., 506 -> 1), it marks a new 'Day' block."
   ]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": [
    "# Identify column names (handling whitespace)\n",
    "col_map = {c.strip(): c for c in df.columns}\n",
    "sl_col = col_map.get('Sl No.', df.columns[0])\n",
    "date_col = col_map.get('MEASUREDATE', 'MEASUREDATE')\n",
    "\n",
    "# Determine segments: New segment starts when Sl No <= previous Sl No\n",
    "df['SegmentID'] = (df[sl_col] <= df[sl_col].shift(1)).cumsum()\n",
    "\n",
    "# Handle the first row (shift produces NaN)\n",
    "df.loc[0, 'SegmentID'] = 0 \n",
    "\n",
    "print(f\"Total identified segments (days): {df['SegmentID'].nunique()}\")"
   ]
  },
  {
   "cell_type": "markdown",
   "metadata": {},
   "source": [
    "## 2. Extract and Solve Dates\n",
    "We pull one date string per segment and try to parse it."
   ]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": [
    "# Get one date per segment\n",
    "segment_dates = df.groupby('SegmentID')[date_col].first().reset_index()\n",
    "segment_dates.columns = ['SegmentID', 'DateStr']\n",
    "\n",
    "# Helper to parse both ways\n",
    "def parse_candidates(d_str):\n",
    "    try:\n",
    "        # Try Day-First\n",
    "        d1 = pd.to_datetime(d_str, dayfirst=True, errors='coerce')\n",
    "        # Try Month-First\n",
    "        d2 = pd.to_datetime(d_str, dayfirst=False, errors='coerce')\n",
    "        return d1, d2\n",
    "    except:\n",
    "        return pd.NaT, pd.NaT\n",
    "\n",
    "solved_dates = []\n",
    "last_date = pd.Timestamp('1900-01-01')\n",
    "\n",
    "# Iterative Solver\n",
    "for idx, row in segment_dates.iterrows():\n",
    "    d_str = row['DateStr']\n",
    "    d_dayfirst, d_monthfirst = parse_candidates(d_str)\n",
    "    \n",
    "    selected_date = pd.NaT\n",
    "    \n",
    "    # Logic:\n",
    "    # 1. If strict equality (e.g. 12/12/2020), no ambiguity.\n",
    "    # 2. If one is invalid (NaT), pick the valid one (e.g. 29/03 -> 29 must be day).\n",
    "    # 3. If both valid, pick the one that is 'after' the last_date but 'closest' to it.\n",
    "    \n",
    "    if pd.isna(d_dayfirst) and pd.isna(d_monthfirst):\n",
    "        # Completely unparsable? Keep NaT\n",
    "        pass\n",
    "    elif pd.isna(d_dayfirst):\n",
    "        selected_date = d_monthfirst\n",
    "    elif pd.isna(d_monthfirst):\n",
    "        selected_date = d_dayfirst\n",
    "    elif d_dayfirst == d_monthfirst:\n",
    "        selected_date = d_dayfirst\n",
    "    else:\n",
    "        # Ambiguity! Use history.\n",
    "        # Candidates: d_dayfirst, d_monthfirst\n",
    "        \n",
    "        # Check continuity\n",
    "        # We prefer Forward movement. \n",
    "        # Ideally diff should be small positive (e.g. +1 day).\n",
    "        \n",
    "        diff1 = (d_dayfirst - last_date).days\n",
    "        diff2 = (d_monthfirst - last_date).days\n",
    "        \n",
    "        # Heuristic: Pick smallest positive jump.\n",
    "        # If both negative (data out of order), pick smallest magnitude?\n",
    "        # Or assume strict day-wise: +1 day.\n",
    "        \n",
    "        if diff1 >= 0 and diff2 < 0:\n",
    "            selected_date = d_dayfirst\n",
    "        elif diff2 >= 0 and diff1 < 0:\n",
    "            selected_date = d_monthfirst\n",
    "        elif diff1 >= 0 and diff2 >= 0:\n",
    "            # Both forward. Pick closer.\n",
    "            if diff1 < diff2:\n",
    "                selected_date = d_dayfirst\n",
    "            else:\n",
    "                selected_date = d_monthfirst\n",
    "        else:\n",
    "            # Both backward? Data might be non-chronological.\n",
    "            # Use DayFirst as default preference in international datasets?\n",
    "            # Or pick closest to 0.\n",
    "            if abs(diff1) < abs(diff2):\n",
    "                 selected_date = d_dayfirst\n",
    "            else:\n",
    "                 selected_date = d_monthfirst\n",
    "    \n",
    "    # Update history if valid\n",
    "    if not pd.isna(selected_date):\n",
    "        # Initialize last_date on first valid\n",
    "        if last_date.year == 1900:\n",
    "             last_date = selected_date\n",
    "        else:\n",
    "             # Only update last_date if we moved forward? \n",
    "             # Users said 'day wise' 2016-2025. Unsorted data is unlikely but possible.\n",
    "             # We assume sorted.\n",
    "             last_date = selected_date\n",
    "    \n",
    "    solved_dates.append(selected_date)\n",
    "\n",
    "segment_dates['SolvedDate'] = solved_dates\n",
    "print(\"Date Resolution Complete.\")\n",
    "segment_dates.head(20)"
   ]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": [
    "# Check for gaps/jumps\n",
    "plt.figure(figsize=(15, 5))\n",
    "plt.plot(segment_dates['SolvedDate'], marker='.')\n",
    "plt.title(\"Timeline of Segments\")\n",
    "plt.ylabel(\"Date\")\n",
    "plt.xlabel(\"Segment Index\")\n",
    "plt.grid(True)\n",
    "plt.show()"
   ]
  },
  {
   "cell_type": "markdown",
   "metadata": {},
   "source": [
    "## 3. Apply and Save\n",
    "Map the solved dates back to the original dataframe segments."
   ]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "metadata": {},
   "outputs": [],
   "source": [
    "# Map back\n",
    "date_map = dict(zip(segment_dates['SegmentID'], segment_dates['SolvedDate']))\n",
    "df['FixedDate'] = df['SegmentID'].map(date_map)\n",
    "\n",
    "# Keep original format columns but update Date\n",
    "df_final = df.drop(columns=['SegmentID', date_col])\n",
    "df_final.insert(1, 'MEASUREDATE', df['FixedDate'])\n",
    "\n",
    "outfile = 'thermocouple_data_fixed.csv'\n",
    "df_final.to_csv(outfile, index=False)\n",
    "print(f\"Saved corrected data to {outfile}\")"
   ]
  }
 ],
 "metadata": {
  "kernelspec": {
   "display_name": "Python 3",
   "language": "python",
   "name": "python3"
  },
  "language_info": {
   "codemirror_mode": {
    "name": "ipython",
    "version": 3
   },
   "file_extension": ".py",
   "mimetype": "text/x-python",
   "name": "python",
   "nbconvert_exporter": "python",
   "pygments_lexer": "ipython3",
   "version": "3.8.5"
  }
 },
 "nbformat": 4,
 "nbformat_minor": 4
}

with open("g:\\Other computers\\My Laptop\\Documents\\Thermocouple Project\\fix_date_ambiguity.ipynb", "w") as f:
    json.dump(nb_content, f, indent=1)
