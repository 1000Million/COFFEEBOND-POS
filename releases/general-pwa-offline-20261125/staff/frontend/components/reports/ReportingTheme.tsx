import type { ReactNode } from 'react';
import StaffTheme, { useStaffAppearance } from '../StaffTheme';
import './ReportingTheme.css';
export default function ReportingTheme({ children }: { children: ReactNode }) {
  const appearance = useStaffAppearance();
  // Standalone report previews use the same provider; the staff app already owns it.
  if (appearance == null) return <StaffTheme><ReportingTheme>{children}</ReportingTheme></StaffTheme>;
  return <section aria-label="Reporting" data-reporting-theme={appearance} className={`reporting-theme${appearance === 'dark' ? ' dark' : ''}`}>{children}</section>;
}
