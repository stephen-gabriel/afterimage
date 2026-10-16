export interface RecordRefProps {
  type: string;
  id: string;
  label?: string;
  /** Human-readable name/description when available from server data.
   * Never invented from the ID. Full ID stays in title and aria-label. */
  title?: string;
  domainStatus?: string;
  onClick: () => void;
  cited?: boolean;
  'data-testid'?: string;
}