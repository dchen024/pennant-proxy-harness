import type { Policy } from "../types";

/** The voting policy as an asset manager would publish it. This is the compiler's input. */
export const POLICY_TEXT = `U.S. Proxy Voting Guidelines — Annual Meetings (excerpt)

These guidelines cover three items that appear on most U.S. annual meeting ballots: the election of the chair of the nominating/governance committee, the advisory vote on executive compensation ("say-on-pay"), and the ratification of the independent auditor. We vote FOR each of these items unless one of the provisions below calls for a vote AGAINST.

1. Board independence — Election of the nominating/governance committee chair. We vote AGAINST the chair of the nominating/governance committee if fewer than two-thirds of the director nominees standing for election are independent.

2. Board leadership — Election of the nominating/governance committee chair. We vote AGAINST the chair of the nominating/governance committee if the Chief Executive Officer also serves as Chair of the Board and the board has not designated a lead independent director.

3. Equal voting rights — Election of the nominating/governance committee chair. We vote AGAINST the chair of the nominating/governance committee if the company has a capital structure with unequal voting rights that is not subject to a time-based sunset.

4. Pay for performance — Advisory vote on executive compensation (say-on-pay). We vote AGAINST the say-on-pay proposal if the CEO's total compensation in the Summary Compensation Table increased compared with the prior fiscal year while the company's total shareholder return for the most recent fiscal year (value of an initial fixed $100 investment, from the Pay Versus Performance table) was below that of its peer group.

5. Auditor independence — Ratification of the independent auditor. We vote AGAINST ratification of the auditor if non-audit fees (tax fees plus all other fees) exceed the sum of audit fees and audit-related fees for the most recent fiscal year.

Where a filing does not disclose the information needed to apply a provision, the item is referred to an analyst for review.`;

/** Hand-compiled, verified trees for POLICY_TEXT. Compiled policies are checked against this. */
export const GOLD_POLICY: Policy = {
  id: "gold",
  name: "U.S. Proxy Voting Guidelines (hand-compiled gold)",
  text: POLICY_TEXT,
  rules: [
    {
      id: "R1",
      item: "nom_gov_chair",
      vote: "AGAINST",
      summary: "Fewer than two-thirds of director nominees are independent.",
      when: {
        op: "cmp",
        cmp: "<",
        left: {
          op: "div",
          left: { fact: "board.independent_nominee_count" },
          right: { fact: "board.nominee_count" },
        },
        right: { const: 2 / 3 },
      },
    },
    {
      id: "R2",
      item: "nom_gov_chair",
      vote: "AGAINST",
      summary: "CEO also chairs the board and there is no lead independent director.",
      when: {
        op: "and",
        args: [
          { op: "fact", fact: "board.ceo_is_chair" },
          { op: "not", arg: { op: "fact", fact: "board.has_lead_independent_director" } },
        ],
      },
    },
    {
      id: "R3",
      item: "nom_gov_chair",
      vote: "AGAINST",
      summary: "Unequal voting rights without a time-based sunset.",
      when: {
        op: "and",
        args: [
          { op: "fact", fact: "governance.unequal_voting_rights" },
          { op: "not", arg: { op: "fact", fact: "governance.unequal_voting_sunset" } },
        ],
      },
    },
    {
      id: "R4",
      item: "say_on_pay",
      vote: "AGAINST",
      summary: "CEO total pay rose year over year while company TSR trailed peer TSR.",
      when: {
        op: "and",
        args: [
          {
            op: "cmp",
            cmp: ">",
            left: { fact: "pay.ceo_total_comp_current" },
            right: { fact: "pay.ceo_total_comp_prior" },
          },
          {
            op: "cmp",
            cmp: "<",
            left: { fact: "pay.company_tsr_current" },
            right: { fact: "pay.peer_tsr_current" },
          },
        ],
      },
    },
    {
      id: "R5",
      item: "auditor",
      vote: "AGAINST",
      summary: "Non-audit fees (tax + all other) exceed audit + audit-related fees.",
      when: {
        op: "cmp",
        cmp: ">",
        left: {
          op: "add",
          left: { fact: "audit.tax_fees_current" },
          right: { fact: "audit.all_other_fees_current" },
        },
        right: {
          op: "add",
          left: { fact: "audit.audit_fees_current" },
          right: { fact: "audit.audit_related_fees_current" },
        },
      },
    },
  ],
};
