import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  PanelRightIcon,
  WindowCloseIcon,
  WindowMaximizeIcon,
  WindowMinimizeIcon,
  WindowRestoreIcon
} from "./icons";

interface WindowTitleBarProps {
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}

export function WindowTitleBar({ inspectorOpen, onToggleInspector }: WindowTitleBarProps) {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let mounted = true;
    let unlisten: (() => void) | undefined;

    const attachListeners = async () => {
      try {
        const appWindow = getCurrentWindow();
        if (mounted) {
          setIsMaximized(await appWindow.isMaximized());
        }

        unlisten = await appWindow.onResized(async () => {
          try {
            if (mounted) {
              setIsMaximized(await appWindow.isMaximized());
            }
          } catch (error) {
            console.warn("Failed to sync maximize state after resize", error);
          }
        });
      } catch (error) {
        console.warn("Failed to initialize window controls", error);
      }
    };

    void attachListeners();

    return () => {
      mounted = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  const runWindowAction = async (action: "minimize" | "toggle" | "close") => {
    try {
      const appWindow = getCurrentWindow();
      if (action === "minimize") {
        await appWindow.minimize();
        return;
      }

      if (action === "toggle") {
        await appWindow.toggleMaximize();
        setIsMaximized(await appWindow.isMaximized());
        return;
      }

      await appWindow.close();
    } catch (error) {
      console.warn(`Window action failed: ${action}`, error);
    }
  };

  return (
    <div className="window-controls" role="toolbar" aria-label="Window controls">
      <button
        type="button"
        className={`window-control-button utility${inspectorOpen ? " active" : ""}`}
        aria-label={inspectorOpen ? "Close inspector" : "Open inspector"}
        title={inspectorOpen ? "Close inspector (Ctrl/Cmd+I)" : "Open inspector (Ctrl/Cmd+I)"}
        onClick={onToggleInspector}
      >
        <PanelRightIcon />
      </button>

      <button
        type="button"
        className="window-control-button"
        aria-label="Minimize"
        onClick={() => void runWindowAction("minimize")}
      >
        <WindowMinimizeIcon />
      </button>

      <button
        type="button"
        className="window-control-button"
        aria-label={isMaximized ? "Restore" : "Maximize"}
        onClick={() => void runWindowAction("toggle")}
      >
        {isMaximized ? <WindowRestoreIcon /> : <WindowMaximizeIcon />}
      </button>

      <button
        type="button"
        className="window-control-button close"
        aria-label="Close"
        onClick={() => void runWindowAction("close")}
      >
        <WindowCloseIcon />
      </button>
    </div>
  );
}
