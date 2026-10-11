import Link from "next/link";
import { workLane } from "@/lanes/work";

export default function WorkPage() {
  return (
    <main>
      <h1>{workLane.title}</h1>
      <p className="lede">Direct-to-executor workspace. The drafting tools land in a later milestone.</p>
      <p>
        <Link href="/">Back</Link>
      </p>
    </main>
  );
}
