import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ImageOff, Plus, Radar, Upload } from "lucide-react";
import { api } from "../api/client";
import type { Summary } from "../api/types";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CameraTable } from "../components/CameraTable";
import { Button, PageHeader } from "../components/ui";
import { useAuth } from "../hooks/auth";

export function CamerasPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const summary = useQuery({ queryKey: ["summary"], queryFn: () => api<Summary>("/cameras/summary"), refetchInterval: 30_000 });
  const picture = summary.data?.picture;
  const showingPicture = params.get("status") === "pictureproblem";
  return (
    <>
      <PageHeader
        title="Cameras"
        description="Search, filter and manage registered cameras."
        actions={
          <>
            {picture && picture.checked > 0 && (
              <Button
                icon={<ImageOff className={clsx("h-4 w-4", picture.problems ? "text-warn" : "text-good")} />}
                aria-pressed={showingPicture}
                variant={showingPicture ? "primary" : "secondary"}
                title={showingPicture ? "Show all cameras" : "Show the cameras whose picture is black, covered, blurred, frozen or moved"}
                onClick={() => navigate(showingPicture ? "/cameras" : "/cameras?status=pictureproblem")}
              >
                {picture.problems ? `Picture problems: ${picture.problems}` : "Pictures OK"}
              </Button>
            )}
            {can("cameras:write") && (
            <>
              <Button icon={<Radar className="h-4 w-4" />} onClick={() => navigate("/cameras/scan")}>
                Scan network
              </Button>
              <Button icon={<Upload className="h-4 w-4" />} onClick={() => navigate("/cameras/import")}>
                Import CSV
              </Button>
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => navigate("/cameras/new")}>
                Add camera
              </Button>
            </>
            )}
          </>
        }
      />
      <CameraTable key={params.toString()} initialStatus={params.get("status") ?? ""} initialRecording={params.get("recording") ?? ""} initialPassword={params.get("password") ?? ""} initialPriority={params.get("priority") ?? ""} initialType={params.get("type") ?? ""} />
    </>
  );
}
