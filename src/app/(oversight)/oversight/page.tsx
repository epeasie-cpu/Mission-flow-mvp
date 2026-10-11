import Link from "next/link";
import { oversightLane } from "@/lanes/oversight";

export default function OversightPage() {
  return (
    <main>
      <h1>{oversightLane.title}</h1>
      <p className="lede">Leadership view for suspense, coordination, and approval. The dashboard lands later.</p>
      <p>
        <Link href="/">Back</Link>
      </p>
    </main>
  );
}
