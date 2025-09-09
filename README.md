# backcharge📑 Backcharge Review Portal
This project is a web-based portal for reviewing, approving, or disputing subcontractor backcharges. It integrates directly with Airtable for data storage and management.

🚀 Features
Review Backcharges in card format, showing:

Job Name (highlighted)

Subcontractor

Customer

Technician

Branch

Reason

Amount

Attached Photos

Photo Gallery Modal to preview images.

Filter & Search

Filter by Technician or Branch

Search by Job Name, Subcontractor, Customer, Technician, or Branch

Approve / Dispute Workflow

Click Approve or Dispute

A confirmation modal appears (with Job Name shown) to prevent accidental clicks

Approvals are green: “Yes, Approve”

Disputes are red: “Dispute”

Airtable Sync

Records are patched directly to Airtable field Decision (single select: Approve or Dispute)

🛠️ Tech Stack
Frontend: HTML, CSS, JavaScript (Vanilla JS)

Database: Airtable

Integration: Airtable REST API

📂 File Structure
bash
Copy
Edit
project-root/
│── index.html             # Backcharge submission form
│── Review.html            # Review portal
│── Review.js    # Review logic, Airtable fetch + patch
│── backchargeReview.css   # Styling (responsive + modals)
│── README.md              # Documentation
🔑 Setup
Clone the repository:

bash
Copy
Edit
git clone https://github.com/your-repo/backcharge-review.git
cd backcharge-review
Update Airtable API credentials in backchargeReview.js:

js
Copy
Edit
const AIRTABLE_API_KEY = "your_api_key_here";
const BASE_ID = "your_base_id_here";
const TABLE_ID = "your_table_id_here";
Serve the project locally:

Option A: Use VSCode’s Live Server extension

Option B: Use python3 -m http.server 5500 and open http://localhost:5500

📸 Screenshots
Review Dashboard
Displays cards with job details and action buttons.

Photo Modal
Click photo link → full gallery modal.

Decision Modal
Prevents accidental Approve/Dispute.

✅ To Do / Future Improvements
 Add pagination for large record sets

 Role-based access (Admins vs Reviewers)

 Mobile optimization enhancements

 Export reviewed backcharges to CSV