import type { FactDef, FactId } from "./types";

// Every leaf in the voting policy is one of these facts. Descriptions are the
// extraction spec: they name the exact table, period and person to read.
export const FACTS: FactDef[] = [
  {
    id: "board.nominee_count",
    type: "number",
    unit: "count",
    label: "Director nominees",
    description:
      "Total number of director nominees standing for election at this annual meeting.",
    query: "director nominees standing for election at the annual meeting number of nominees",
  },
  {
    id: "board.independent_nominee_count",
    type: "number",
    unit: "count",
    label: "Independent nominees",
    description:
      "Number of the director nominees standing for election that the board has determined to be independent.",
    query: "director nominees independent under listing standards board determined independence",
  },
  {
    id: "board.ceo_is_chair",
    type: "boolean",
    label: "CEO is also Chair",
    description: "True if the current Chief Executive Officer also serves as Chair of the Board.",
    query: "board leadership structure chair of the board and chief executive officer roles combined or separate",
  },
  {
    id: "board.has_lead_independent_director",
    type: "boolean",
    label: "Lead independent director",
    description:
      "True if the board has a designated Lead Independent Director role (sometimes called Lead Director or Presiding Director). An independent Chair of the Board does not count: answer false when the company has an independent Chair and no lead director role.",
    query: "lead independent director role and responsibilities board leadership",
  },
  {
    id: "governance.unequal_voting_rights",
    type: "boolean",
    label: "Unequal voting rights",
    description:
      "True if the company has more than one class of common stock with unequal voting rights (for example Class B shares with 10 votes per share).",
    query: "classes of common stock votes per share voting power Class A Class B",
  },
  {
    id: "governance.unequal_voting_sunset",
    type: "boolean",
    label: "Time-based sunset on unequal voting",
    description:
      "True only if a time-based sunset provision will eliminate unequal voting rights. False otherwise, including when there is only one class of voting stock.",
    query: "sunset provision automatic conversion of high-vote shares dual class structure expiration",
  },
  {
    id: "pay.ceo_total_comp_current",
    type: "number",
    unit: "usd",
    label: "CEO total pay (latest FY)",
    description:
      "The CEO's (principal executive officer's) 'Total' compensation from the Summary Compensation Table for the most recent fiscal year covered by this proxy statement, in US dollars.",
    query: "Summary Compensation Table total compensation chief executive officer salary bonus stock awards",
  },
  {
    id: "pay.ceo_total_comp_prior",
    type: "number",
    unit: "usd",
    label: "CEO total pay (prior FY)",
    description:
      "The CEO's (principal executive officer's) 'Total' compensation from the Summary Compensation Table for the fiscal year immediately before the most recent one, in US dollars.",
    query: "Summary Compensation Table total compensation chief executive officer prior fiscal year",
  },
  {
    id: "pay.company_tsr_current",
    type: "number",
    unit: "index",
    label: "Company TSR ($100 index)",
    description:
      "From the Pay Versus Performance table: value of an initial fixed $100 investment based on the company's total shareholder return, for the most recent fiscal year.",
    query: "pay versus performance value of initial fixed $100 investment based on company total shareholder return",
  },
  {
    id: "pay.peer_tsr_current",
    type: "number",
    unit: "index",
    label: "Peer TSR ($100 index)",
    description:
      "From the Pay Versus Performance table: value of an initial fixed $100 investment based on the peer group total shareholder return, for the most recent fiscal year.",
    query: "pay versus performance value of initial fixed $100 investment based on peer group total shareholder return",
  },
  {
    id: "audit.audit_fees_current",
    type: "number",
    unit: "usd",
    label: "Audit fees (latest FY)",
    description:
      "'Audit Fees' billed by the independent registered public accounting firm for the most recent fiscal year, in US dollars.",
    query: "fees billed by independent registered public accounting firm audit fees audit-related fees tax fees all other fees",
  },
  {
    id: "audit.audit_related_fees_current",
    type: "number",
    unit: "usd",
    label: "Audit-related fees (latest FY)",
    description:
      "'Audit-Related Fees' billed by the independent registered public accounting firm for the most recent fiscal year, in US dollars.",
    query: "audit-related fees billed by independent registered public accounting firm fiscal year",
  },
  {
    id: "audit.tax_fees_current",
    type: "number",
    unit: "usd",
    label: "Tax fees (latest FY)",
    description:
      "'Tax Fees' billed by the independent registered public accounting firm for the most recent fiscal year, in US dollars.",
    query: "tax fees billed by independent registered public accounting firm tax compliance planning",
  },
  {
    id: "audit.all_other_fees_current",
    type: "number",
    unit: "usd",
    label: "All other fees (latest FY)",
    description:
      "'All Other Fees' billed by the independent registered public accounting firm for the most recent fiscal year, in US dollars. Use 0 if the table shows a dash or none.",
    query: "all other fees billed by independent registered public accounting firm",
  },
];

export const FACT_BY_ID: Record<FactId, FactDef> = Object.fromEntries(
  FACTS.map((f) => [f.id, f]),
) as Record<FactId, FactDef>;
