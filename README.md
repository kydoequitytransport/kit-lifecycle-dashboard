Kit Lifecycle Dashboard

This dashboard helps the operations team track kits sent to customers.

It shows:
- How many kits are being processed
- Which kits may need follow-up
- How long each step takes
- The event history for each order

To run it, open a terminal in this folder and run:

python3 -m http.server 8000

Then open http://localhost:8000 in your browser.

The dashboard uses orders.csv and kit_events.csv. The included data is made up for this demo. You can also load your own two CSV files with the same columns.

The dashboard does not show test, unpaid, cancelled, refunded, or upload-only orders. It uses October 20, 2026 as the sample data date.
