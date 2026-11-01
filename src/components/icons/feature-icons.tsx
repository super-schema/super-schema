import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function FeatureIcon({ children, ...props }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function EntityIcon(props: IconProps) {
  return (
    <FeatureIcon {...props} data-feature-icon="entities">
      <rect x="4" y="3" width="16" height="18" rx="2.5"/>
      <path d="M10 8h6M10 12h6M10 16h4"/>
      <path d="M7 8h.01M7 12h.01M7 16h.01" stroke="var(--icon-accent, currentColor)"/>
    </FeatureIcon>
  );
}

export function DataTypeIcon(props: IconProps) {
  return (
    <FeatureIcon {...props} data-feature-icon="data-types">
      <path d="M8 3H7a2 2 0 0 0-2 2v4a3 3 0 0 1-2 3 3 3 0 0 1 2 3v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a3 3 0 0 0 2 3 3 3 0 0 0-2 3v4a2 2 0 0 1-2 2h-1"/>
      <rect x="10" y="6" width="4" height="4" rx=".5"/>
      <circle cx="12" cy="16" r="2" stroke="var(--icon-accent, currentColor)"/>
    </FeatureIcon>
  );
}

export function ApiIcon(props: IconProps) {
  return (
    <FeatureIcon {...props} data-feature-icon="api-contracts">
      <path d="m7 5-5 7 5 7m10-14 5 7-5 7"/>
      <path d="m14 4-4 16" stroke="var(--icon-accent, currentColor)"/>
    </FeatureIcon>
  );
}

export function EventIcon(props: IconProps) {
  return (
    <FeatureIcon {...props} data-feature-icon="events">
      <circle cx="12" cy="12" r="2" stroke="var(--icon-accent, currentColor)"/>
      <path d="M8.5 8.5a5 5 0 0 0 0 7m7-7a5 5 0 0 1 0 7M5.5 5.5a9.2 9.2 0 0 0 0 13m13-13a9.2 9.2 0 0 1 0 13"/>
    </FeatureIcon>
  );
}

export function GovernanceIcon(props: IconProps) {
  return (
    <FeatureIcon {...props} data-feature-icon="governance">
      <path d="m12 3 8 3v6c0 4-5 7.5-8 9-3-1.5-8-5-8-9V6Z"/>
      <path d="m8.5 12 2.5 2.5 4.5-5" stroke="var(--icon-accent, currentColor)"/>
    </FeatureIcon>
  );
}

export function VersioningIcon(props: IconProps) {
  return (
    <FeatureIcon {...props} data-feature-icon="versioning">
      <path d="M3 10a9 9 0 1 1 .5 6M3 4v6h6"/>
      <path d="M12 7v6l3 2" stroke="var(--icon-accent, currentColor)"/>
    </FeatureIcon>
  );
}

export function RelationshipsIcon(props: IconProps) {
  return (
    <FeatureIcon {...props} data-feature-icon="relationships">
      <rect x="2" y="3" width="7" height="7" rx="1.5"/>
      <rect x="15" y="14" width="7" height="7" rx="1.5"/>
      <path d="M9 6.5h1a2 2 0 0 1 2 2v7a2 2 0 0 0 2 2h1" stroke="var(--icon-accent, currentColor)"/>
    </FeatureIcon>
  );
}

export function GenerationIcon(props: IconProps) {
  return (
    <FeatureIcon {...props} data-feature-icon="generation">
      <rect x="8" y="2" width="8" height="6" rx="1.5"/>
      <path d="M12 8v9M4 17v-4h16v4" stroke="var(--icon-accent, currentColor)"/>
      <rect x="2" y="17" width="4" height="4" rx="1"/>
      <rect x="10" y="17" width="4" height="4" rx="1"/>
      <rect x="18" y="17" width="4" height="4" rx="1"/>
    </FeatureIcon>
  );
}
