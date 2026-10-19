import { createRoot } from "react-dom/client";
import "@/index.css";
import BrowseApp from "@/pages/BrowseApp";
import { Toaster } from "@/components/ui/sonner";

createRoot(document.getElementById("root")!).render(
  <>
    <BrowseApp />
    <Toaster />
  </>
);
