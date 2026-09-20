import type { Metadata } from "next";
import { SocialMemorySite } from "./SocialMemorySite";

export const metadata: Metadata = {
  title: "Trace Garden — Social Memory for Creators",
  description:
    "Turn your social archive into searchable memory and new creative work with a private, source-aware creative agent.",
};

export default function MemoryConceptPage() {
  return <SocialMemorySite />;
}
