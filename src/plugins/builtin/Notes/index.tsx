import React, { useEffect, useRef, useState } from "react";
import Vditor from "vditor";
import "vditor/dist/index.css";
import {
  BaseDirectory,
  readTextFile,
  writeTextFile,
  mkdir,
  exists,
  readDir,
} from "@tauri-apps/plugin-fs";
import { appDataDir } from "@tauri-apps/api/path";
import { FileText, Save, Plus, Trash2, FolderOpen } from "lucide-react";
import "./style.css";

const Notes: React.FC = () => {
  const [vditor, setVditor] = useState<Vditor>();
  const [files, setFiles] = useState<string[]>([]);
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [notesDir, setNotesDir] = useState<string>("");
  const editorRef = useRef<HTMLDivElement>(null);
  const vditorInstanceRef = useRef<Vditor | null>(null);

  // Initialize directory and load files
  useEffect(() => {
    const init = async () => {
      const appData = await appDataDir();
      // simple concat for now, better use path.join if available or just string concat carefully
      // On Windows this might need separator handling, but Tauri usually handles forward slashes fine in JS APIs
      const dir = `${appData}/notes`;
      setNotesDir(dir);

      if (!(await exists("notes", { baseDir: BaseDirectory.AppData }))) {
        await mkdir("notes", {
          baseDir: BaseDirectory.AppData,
          recursive: true,
        });
      }
      loadFiles();
    };
    init();
  }, []);

  const loadFiles = async () => {
    try {
      const entries = await readDir("notes", {
        baseDir: BaseDirectory.AppData,
      });
      const mdFiles = entries
        .filter((e) => e.isFile && e.name.endsWith(".md"))
        .map((e) => e.name);
      setFiles(mdFiles);
    } catch (error) {
      console.error("Failed to load files:", error);
    }
  };

  useEffect(() => {
    if (!editorRef.current) return;

    let instance: Vditor | undefined;
    try {
      instance = new Vditor(editorRef.current, {
        height: "100%",
        cache: { enable: false },
        mode: "ir",
        toolbarConfig: {
          pin: true,
        },
        toolbar: [
          "emoji",
          "headings",
          "bold",
          "italic",
          "strike",
          "link",
          "|",
          "list",
          "ordered-list",
          "check",
          "outdent",
          "indent",
          "|",
          "quote",
          "line",
          "code",
          "inline-code",
          "insert-before",
          "insert-after",
          "|",
          "upload",
          "record",
          "table",
          "|",
          "undo",
          "redo",
          "|",
          "edit-mode",
          "content-theme",
          "code-theme",
          "export",
        ],
        after: () => {
          // Check if component is still mounted and instance matches
          if (vditorInstanceRef.current === instance) {
            setVditor(instance);
            if (currentFile) {
              loadFileContent(currentFile, instance);
            } else {
              instance.setValue(
                "# Welcome to Notes\nSelect or create a file to start.",
              );
            }
          } else {
            // Orphaned instance, destroy it
            instance?.destroy();
          }
        },
      });
      vditorInstanceRef.current = instance;
    } catch (e) {
      console.error("Failed to initialize Vditor:", e);
    }

    return () => {
      try {
        instance?.destroy();
      } catch (e) {
        console.warn("Error destroying Vditor:", e);
      }
      vditorInstanceRef.current = null;
      setVditor(undefined);
    };
  }, []);

  // Load file content when currentFile changes
  useEffect(() => {
    if (currentFile && vditor) {
      loadFileContent(currentFile, vditor);
    }
  }, [currentFile, vditor]);

  const loadFileContent = async (fileName: string, instance: Vditor) => {
    try {
      const content = await readTextFile(`notes/${fileName}`, {
        baseDir: BaseDirectory.AppData,
      });
      instance.setValue(content);
    } catch (error) {
      console.error("Failed to read file:", error);
      instance.setValue("# Error loading file");
    }
  };

  const handleCreateFile = async () => {
    const fileName = `Note-${Date.now()}.md`;
    try {
      await writeTextFile(`notes/${fileName}`, "# New Note\n", {
        baseDir: BaseDirectory.AppData,
      });
      await loadFiles();
      setCurrentFile(fileName);
    } catch (error) {
      console.error("Failed to create file:", error);
    }
  };

  const handleSave = async () => {
    if (!currentFile || !vditor) return;
    try {
      const content = vditor.getValue();
      await writeTextFile(`notes/${currentFile}`, content, {
        baseDir: BaseDirectory.AppData,
      });
      // Maybe show a toast
      console.log("Saved");
    } catch (error) {
      console.error("Failed to save file:", error);
    }
  };

  const handleDelete = async (e: React.MouseEvent, fileName: string) => {
    e.stopPropagation();
    if (!confirm(`Delete ${fileName}?`)) return;

    try {
      // removeFile is not exported from @tauri-apps/plugin-fs directly in some versions?
      // It should be 'remove' or 'removeFile'. Let's check docs or just use remove for now.
      // Actually tauri v2 plugin-fs uses 'remove'.
      // Wait, the import above only has readTextFile etc. I need to add 'remove'.
      // Let's assume it's 'remove' and add it to imports later if needed.
      // EDIT: Checking imports, I didn't import 'remove'. I will use 'remove' from plugin-fs.
      const { remove } = await import("@tauri-apps/plugin-fs");
      await remove(`notes/${fileName}`, { baseDir: BaseDirectory.AppData });
      await loadFiles();
      if (currentFile === fileName) {
        setCurrentFile(null);
        vditor?.setValue("");
      }
    } catch (error) {
      console.error("Failed to delete file:", error);
    }
  };

  return (
    <div
      className="flex h-full w-full"
      style={{ background: "var(--color-bg)", color: "var(--color-text)" }}
    >
      {/* Sidebar */}
      <div
        className="w-64 border-r flex flex-col"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-bg-secondary, var(--color-bg))",
        }}
      >
        <div
          className="p-4 border-b flex justify-between items-center"
          style={{ borderColor: "var(--color-border)" }}
        >
          <h2 className="font-semibold text-lg flex items-center gap-2">
            <FolderOpen size={20} />
            Notes
          </h2>
          <button
            onClick={handleCreateFile}
            className="p-1 rounded-md transition-colors text-blue-600 hover:opacity-80"
            title="New Note"
          >
            <Plus size={20} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {files.map((file) => (
            <div
              key={file}
              onClick={() => setCurrentFile(file)}
              className={`
                                group flex items-center justify-between p-2 rounded-md cursor-pointer text-sm
                                ${currentFile === file ? "bg-blue-100 text-blue-700" : "hover:opacity-80"}
                            `}
            >
              <div className="flex items-center gap-2 truncate">
                <FileText size={16} />
                <span className="truncate">{file}</span>
              </div>
              <button
                onClick={(e) => handleDelete(e, file)}
                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-100 hover:text-red-600 rounded"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Editor Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative">
        <div className="absolute top-2 right-4 z-10 flex gap-2">
          <button
            onClick={handleSave}
            className="flex items-center gap-1 px-3 py-1.5 bg-blue-600 text-white rounded-md shadow hover:bg-blue-700 transition-colors text-sm font-medium"
          >
            <Save size={16} />
            Save
          </button>
        </div>
        <div ref={editorRef} className="h-full w-full" />
      </div>
    </div>
  );
};

export default Notes;
