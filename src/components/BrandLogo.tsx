interface BrandLogoProps {
  size?: 'small' | 'large';
}

export function BrandLogo({ size = 'small' }: BrandLogoProps) {
  return (
    <img
      className={`brand-logo ${size === 'large' ? 'brand-logo-large' : ''}`}
      src="/ai-usage-tracker-logo.png"
      alt=""
      aria-hidden="true"
      draggable="false"
    />
  );
}
