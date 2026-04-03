export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative min-h-screen flex items-center justify-center p-space-4 overflow-hidden bg-background">
      {/* Gradient base */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(164,119,178,0.15),transparent_50%),radial-gradient(ellipse_at_bottom_right,rgba(245,192,192,0.1),transparent_50%)]" />

      {/* Floating decorative blobs */}
      <div className="absolute top-[-10%] left-[-5%] w-[400px] h-[400px] rounded-full bg-primary/[0.07] blur-[80px] animate-auth-float pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-5%] w-[350px] h-[350px] rounded-full bg-secondary/[0.06] blur-[80px] animate-auth-float-delayed pointer-events-none" />

      {/* Subtle grid overlay */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(rgba(164,119,178,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(164,119,178,0.5) 1px, transparent 1px)",
          backgroundSize: "64px 64px",
        }}
      />

      {/* Content */}
      <div className="relative z-10 w-full max-w-[420px] animate-auth-fade-up">
        {children}
      </div>
    </div>
  );
}
