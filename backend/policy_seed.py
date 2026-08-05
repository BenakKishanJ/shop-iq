"""Seed policy documents: the store's own knowledge base.

These are self-authored to be realistic retail policies. Each document is a
list of (section_title, body) pairs so chunking can respect headings —
every chunk gets a citable section label.
"""

SEED_DOCS = [
    {
        "title": "Returns and Refunds Policy",
        "sections": [
            (
                "Returns Window",
                "Customers have 30 days from the date of purchase to return any "
                "unused item in its original packaging for a full refund. Returns "
                "after 30 days but within 90 days receive store credit only.",
            ),
            (
                "Opened Electronics",
                "Opened items of an electronic nature cannot be exchanged or "
                "refunded once the packaging seal has been broken, unless the item "
                "is found to be defective. This policy is displayed at all POS "
                "terminals.",
            ),
            (
                "Defective Items",
                "If a product arrives damaged or is defective within the first 14 "
                "days, the customer is entitled to a full refund including "
                "shipping costs. No restocking fee applies to defective returns.",
            ),
            (
                "Restocking Fee",
                "Non-defective returns that are missing original packaging or "
                "include non-saleable condition are subject to a 15 percent "
                "restocking fee.",
            ),
        ],
    },
    {
        "title": "Supplier Payment Terms",
        "sections": [
            (
                "Standard Terms",
                "Standard payment terms with suppliers are net-30, calculated "
                "from the invoice date. Early payment within 10 days earns a 2 "
                "percent discount.",
            ),
            (
                "Large Order Deposits",
                "Orders exceeding 5,000 pounds require a 20 percent deposit at "
                "the time of order confirmation. The balance is due before "
                "delivery is scheduled.",
            ),
            (
                "Dispute Resolution",
                "Disputed invoices must be raised in writing within 14 days of "
                "the invoice date. Disputes are reviewed by the finance team "
                "within 5 working days.",
            ),
        ],
    },
    {
        "title": "Product Safety and Compliance Checklist",
        "sections": [
            (
                "Electrical Goods",
                "All electrical items must carry a valid CE mark and a UKCA "
                "marking. Products without the required certification must not "
                "be listed for sale.",
            ),
            (
                "Children's Products",
                "Toys and children's products must comply with EN71 safety "
                "standards. Batches without a conformity declaration are "
                "quarantined until documentation is received.",
            ),
            (
                "Recalls",
                "Any product subject to a recall notice must be removed from "
                "shelves and web listings immediately, and flagged in the "
                "inventory system within 24 hours.",
            ),
        ],
    },
    {
        "title": "Pricing and Discounts Policy",
        "sections": [
            (
                "Staff Discount",
                "Permanent staff receive a 15 percent discount on all retail "
                "prices, capped at 200 pounds per transaction.",
            ),
            (
                "Price Matching",
                "We match competitor prices on identical items when a proof of "
                "the lower price is shown at the till. Price matching does not "
                "apply to clearance items or bundle deals.",
            ),
            (
                "Seasonal Markdowns",
                "Seasonal stock is marked down in three stages: 20 percent after "
                "two weeks, 40 percent after four weeks, and 60 percent after "
                "six weeks before clearance.",
            ),
        ],
    },
    {
        "title": "Stock Handling and Restocking Procedure",
        "sections": [
            (
                "Reorder Thresholds",
                "A product should be flagged for reorder when its current stock "
                "falls below 20 units or when projected weekly demand exceeds "
                "current stock, whichever comes first.",
            ),
            (
                "Restocking Lead Time",
                "Standard products carry a 7-day supplier lead time. Overseas "
                "items carry a 21-day lead time and should be reordered with a "
                "larger safety margin.",
            ),
            (
                "Shelf Life and Rotation",
                "Perishable goods follow first-in-first-out rotation. Products "
                "within 60 days of their sell-by date are marked down and moved "
                "to the clearance aisle.",
            ),
        ],
    },
    {
        "title": "Customer Data and Privacy Policy",
        "sections": [
            (
                "Data Retention",
                "Customer purchase records are retained for 6 years to satisfy "
                "tax obligations, then deleted from the active database.",
            ),
            (
                "Marketing Consent",
                "Customers must opt in to receive marketing emails. Opted-out "
                "customers are never contacted for promotions.",
            ),
            (
                "Data Access",
                "Only the store manager and the accounts team have access to "
                "customer purchase histories. Staff cannot access customer data "
                "outside of the point-of-sale system.",
            ),
        ],
    },
]
