import { DashboardClientShell } from "@/components/layout/DashboardClientShell";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <DashboardClientShell>{children}</DashboardClientShell>;
}
