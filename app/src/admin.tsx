import { createRoot } from "react-dom/client";
import "@/index.css";
import AdminApp from "@/pages/AdminApp";
import { Toaster } from "@/components/ui/sonner";

createRoot(document.getElementById("root")!).render(
  <>
    <AdminApp />
    <Toaster />
  </>
);
