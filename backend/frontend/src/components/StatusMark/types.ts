export interface StatusMarkProps {
  status: string;
  size?: 'small' | 'medium' | 'large';
  variant?: 'current' | 'historical' | 'pending';
  showLabel?: boolean;
  historicalRef?: number;
  'data-testid'?: string;
}