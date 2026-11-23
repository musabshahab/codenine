/** The document tools that read files, which an agent without `readFiles` does not get. */
export const DOCUMENT_READ_TOOLS = [
  "codenine_spreadsheet_read",
  "codenine_pdf_read",
  "codenine_deck_read",
] as const;

/** The document tools that change files, which an agent without `editFiles` does not get. */
export const DOCUMENT_EDIT_TOOLS = [
  "codenine_spreadsheet_edit",
  "codenine_pdf_edit",
  "codenine_deck_edit",
] as const;
