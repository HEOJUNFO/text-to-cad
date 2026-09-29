import logoUrl from "../../assets/logo-cad.png";

/** The CAD brand remains visible while a file loads. */
export default function ViewerBrand() {
  return <img src={logoUrl} alt="CAD" width={56} height={24} className="mr-1 h-6 w-auto shrink-0 object-contain" />;
}
