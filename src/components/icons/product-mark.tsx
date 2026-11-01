import Image from "next/image";

export function ProductMark({ className }: { className?: string }) {
  return <Image src="/icon.svg" alt="" width={28} height={28} className={className} aria-hidden="true" />;
}
