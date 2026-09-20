import type { Metadata } from "next";
import { SocialMemorySite } from "./SocialMemorySite";

export const metadata: Metadata = {
  title: "Memory Layer — Your life across the internet, remembered",
  description:
    "A private memory layer that turns your scattered social history into searchable context, creative references, and useful personal agents.",
};

export default function MemoryConceptPage() {
  return <SocialMemorySite />;
}
