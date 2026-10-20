import { createRoot } from "react-dom/client";
import "@/index.css";
import HomeApp from "@/pages/HomeApp";
import { Toaster } from "@/components/ui/sonner";

createRoot(document.getElementById("root")!).render(
  <>
    <HomeApp />
    <Toaster />
  </>
);
