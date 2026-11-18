using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PathOfKungFuSaveEditor
{
    internal static class Program
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool SetDllDirectory(string lpPathName);

        private static readonly string RuntimeDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "PathOfKungFuSaveEditor", "runtime-1.0");

        [STAThread]
        private static int Main(string[] args)
        {
            AppDomain.CurrentDomain.AssemblyResolve += OnAssemblyResolve;

            try
            {
                ExtractResources();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("resource extraction failed: " + ex.Message);
                return 1;
            }

            if (args != null && args.Length >= 2 && string.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                string outDir = args[1];
                string seed = args.Length >= 3 ? args[2] : null;
                try
                {
                    return SelfTest.Run(outDir, seed);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine("self-test failed: " + ex);
                    try
                    {
                        Directory.CreateDirectory(outDir);
                        File.WriteAllText(Path.Combine(outDir, "receipt.json"),
                            "{\"ok\":false,\"error\":" + Quote(ex.Message) + "}");
                    }
                    catch { }
                    return 1;
                }
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            MainForm form = new MainForm();
            Application.Run(form);
            return 0;
        }

        private static string Quote(string s)
        {
            if (s == null) s = "";
            JavaScriptSerializer ser = new JavaScriptSerializer();
            return ser.Serialize(s);
        }

        private static Assembly OnAssemblyResolve(object sender, ResolveEventArgs args)
        {
            string name = new AssemblyName(args.Name).Name;
            if (name == "Microsoft.Web.WebView2.Core")
                return LoadEmbeddedAssembly("Microsoft.Web.WebView2.Core.dll");
            if (name == "Microsoft.Web.WebView2.WinForms")
                return LoadEmbeddedAssembly("Microsoft.Web.WebView2.WinForms.dll");
            return null;
        }

        private static Assembly LoadEmbeddedAssembly(string fileName)
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream(fileName))
            {
                if (s == null) return null;
                byte[] buf = new byte[s.Length];
                int off = 0;
                while (off < buf.Length)
                {
                    int n = s.Read(buf, off, buf.Length - off);
                    if (n <= 0) break;
                    off += n;
                }
                return Assembly.Load(buf);
            }
        }

        private static void ExtractResources()
        {
            string appDir = Path.GetDirectoryName(RuntimeDir);
            SaveStore.NoLinks(appDir, true);
            Directory.CreateDirectory(appDir);
            SaveStore.NoLinks(RuntimeDir, true);
            Directory.CreateDirectory(RuntimeDir);
            SaveStore.NoLinks(RuntimeDir, false);
            string loaderPath = Path.Combine(RuntimeDir, "WebView2Loader.dll");
            SaveStore.NoLinks(loaderPath, true);
            if (!File.Exists(loaderPath))
            {
                Assembly asm = Assembly.GetExecutingAssembly();
                using (Stream s = asm.GetManifestResourceStream("WebView2Loader.dll"))
                {
                    if (s != null)
                    {
                        string tmp = loaderPath + ".tmp";
                        using (FileStream fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            byte[] buf = new byte[65536];
                            int n;
                            while ((n = s.Read(buf, 0, buf.Length)) > 0)
                                fs.Write(buf, 0, n);
                        }
                        if (File.Exists(loaderPath)) File.Delete(loaderPath);
                        File.Move(tmp, loaderPath);
                    }
                }
            }
            SaveStore.NoLinks(loaderPath, false);
            SetDllDirectory(RuntimeDir);
        }

        internal static string LoadHtml()
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            using (Stream s = asm.GetManifestResourceStream("PathOfKungFuSaveEditor-v1.0.html"))
            {
                if (s == null) throw new InvalidOperationException("html resource missing");
                using (StreamReader r = new StreamReader(s, Encoding.UTF8))
                    return r.ReadToEnd();
            }
        }
    }

    internal sealed class MainForm : Form
    {
        private WebView2 _wv;
        private string _html;
        public string WebViewVersion { get; private set; }

        public MainForm()
        {
            Text = "Path of Kung Fu Save Editor";
            Width = 960;
            Height = 720;
            StartPosition = FormStartPosition.CenterScreen;
            _html = Program.LoadHtml();

            _wv = new WebView2();
            _wv.Dock = DockStyle.Fill;
            Controls.Add(_wv);
            _wv.CoreWebView2InitializationCompleted += OnInitCompleted;
        }

        public async Task InitializeWebViewCoreAsync(string userDataDir)
        {
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, userDataDir, null);
            await _wv.EnsureCoreWebView2Async(env);
            await Task.Yield();
        }

        private void OnInitCompleted(object sender, CoreWebView2InitializationCompletedEventArgs e)
        {
            if (!e.IsSuccess) return;
            CoreWebView2 core = _wv.CoreWebView2;
            try { WebViewVersion = core.Environment.BrowserVersionString; } catch { WebViewVersion = ""; }
            CoreWebView2Settings st = core.Settings;
            st.AreDevToolsEnabled = false;
            st.AreDefaultContextMenusEnabled = false;
            st.AreHostObjectsAllowed = false;
            st.IsStatusBarEnabled = false;
            core.NavigationStarting += OnNavigationStarting;
            core.WebMessageReceived += OnWebMessage;
            core.NavigateToString(_html);
        }

        private static bool IsInternalDocumentUri(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return false;
            return uri.StartsWith("about:blank", StringComparison.OrdinalIgnoreCase)
                || uri.StartsWith("data:text/html", StringComparison.OrdinalIgnoreCase);
        }

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (e != null && !IsInternalDocumentUri(e.Uri))
            {
                e.Cancel = true;
            }
        }

        public WebView2 GetWebView()
        {
            return _wv;
        }

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string src = "";
            try { src = e.Source ?? ""; } catch { src = ""; }
            if (!IsInternalDocumentUri(src))
                return;
            string raw;
            try { raw = e.TryGetWebMessageAsString(); }
            catch { try { raw = e.WebMessageAsJson; } catch { raw = null; } }
            if (raw == null) return;

            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = 64 * 1024 * 1024;
            object id = null;
            Dictionary<string, object> reply = new Dictionary<string, object>();
            try
            {
                Dictionary<string, object> msg = ser.Deserialize<Dictionary<string, object>>(raw);
                if (msg == null) throw new InvalidOperationException("Invalid message.");
                id = msg.ContainsKey("id") ? msg["id"] : null;
                string method = GetStr(msg, "method") ?? GetStr(msg, "action");
                object pRaw = msg.ContainsKey("params") ? msg["params"] : (msg.ContainsKey("payload") ? msg["payload"] : null);
                Dictionary<string, object> pDict = pRaw as Dictionary<string, object>;
                Dictionary<string, object> res = HandleRpc(method, pDict);
                reply["id"] = id;
                reply["ok"] = true;
                reply["result"] = res;
            }
            catch (Exception ex)
            {
                reply["id"] = id;
                reply["ok"] = false;
                reply["error"] = ex.Message;
            }
            try { _wv.CoreWebView2.PostWebMessageAsJson(ser.Serialize(reply)); } catch { }
        }

        private static string GetStr(Dictionary<string, object> d, string key)
        {
            if (d == null || !d.ContainsKey(key)) return null;
            object v = d[key];
            return v == null ? null : Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        private static string ResolveActiveRoot()
        {
            string envRoot = Environment.GetEnvironmentVariable("POKF_SAVE_ROOT");
            if (!string.IsNullOrEmpty(envRoot) && Directory.Exists(envRoot))
                return Path.GetFullPath(envRoot);
            List<string> roots = SaveStore.DiscoverRoots();
            if (roots != null && roots.Count > 0 && !string.IsNullOrEmpty(roots[0]))
                return roots[0];
            return "";
        }

        private static string ResolveSafeChild(string root, string nameOrPath)
        {
            if (string.IsNullOrEmpty(root))
                throw new InvalidOperationException("Save root unavailable.");
            if (string.IsNullOrEmpty(nameOrPath))
                throw new ArgumentException("Target name is required.");
            string canonicalRoot = Path.GetFullPath(root);
            if (!canonicalRoot.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal))
                canonicalRoot += Path.DirectorySeparatorChar;
            if (nameOrPath.IndexOf("..", StringComparison.Ordinal) >= 0)
                throw new InvalidOperationException("Path traversal rejected.");
            string candidate = Path.IsPathRooted(nameOrPath) ? nameOrPath : Path.Combine(canonicalRoot, nameOrPath);
            string full = Path.GetFullPath(candidate);
            if (!full.StartsWith(canonicalRoot, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Path outside save root.");
            return full;
        }

        private static Dictionary<string, object> HandleRpc(string method, Dictionary<string, object> p)
        {
            if (string.IsNullOrEmpty(method))
                throw new InvalidOperationException("RPC method required.");
            if (p == null) p = new Dictionary<string, object>();
            string root = ResolveActiveRoot();
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = 64 * 1024 * 1024;

            if (method == "list_slots")
            {
                Dictionary<string, object> r = new Dictionary<string, object>();
                List<Dictionary<string, object>> slots = new List<Dictionary<string, object>>();
                if (!string.IsNullOrEmpty(root) && Directory.Exists(root))
                {
                    List<SaveSlotInfo> found = SaveStore.ListSlots(root);
                    for (int i = 0; i < found.Count; i++)
                    {
                        Dictionary<string, object> item = new Dictionary<string, object>();
                        item["name"] = Path.GetFileName(found[i].FilePath);
                        item["path"] = found[i].FilePath;
                        item["slotId"] = found[i].SlotId;
                        item["summary"] = found[i].Summary;
                        slots.Add(item);
                    }
                }
                r["root"] = root;
                r["slots"] = slots;
                return r;
            }

            if (method == "load_slot")
            {
                string name = GetStr(p, "name");
                string path = GetStr(p, "path");
                string resolved = !string.IsNullOrEmpty(path) ? ResolveSafeChild(root, path) : ResolveSafeChild(root, name);
                SaveLoadResult sd = SaveStore.LoadSlot(resolved);
                object dataObj = ser.DeserializeObject(sd.JsonText);
                Dictionary<string, object> r = new Dictionary<string, object>();
                r["name"] = Path.GetFileName(sd.Path);
                r["slotId"] = sd.SlotId;
                r["key"] = sd.SaveKey;
                r["path"] = sd.Path;
                r["data"] = dataObj;
                return r;
            }

            if (method == "save_slot")
            {
                string name = GetStr(p, "name");
                string path = GetStr(p, "path");
                string resolved = !string.IsNullOrEmpty(path) ? ResolveSafeChild(root, path) : ResolveSafeChild(root, name);
                string slotId = GetStr(p, "slotId");
                if (string.IsNullOrEmpty(slotId))
                {
                    Match m = Regex.Match(Path.GetFileName(resolved), @"PlayerData_(\d+)\.save", RegexOptions.IgnoreCase);
                    if (m.Success) slotId = m.Groups[1].Value;
                }
                if (string.IsNullOrEmpty(slotId)) slotId = "1";
                string jsonText = GetStr(p, "jsonText");
                if (string.IsNullOrEmpty(jsonText))
                    jsonText = ser.Serialize(p.ContainsKey("data") ? p["data"] : null);
                SaveWriteResult wr = SaveStore.SaveWithBackup(resolved, jsonText, slotId);
                Dictionary<string, object> r = new Dictionary<string, object>();
                r["name"] = Path.GetFileName(wr.Path);
                r["path"] = wr.Path;
                r["backupPath"] = wr.BackupPath ?? "";
                r["sha256"] = wr.Sha256 ?? "";
                return r;
            }

            if (method == "list_backups")
            {
                Dictionary<string, object> r = new Dictionary<string, object>();
                List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
                if (!string.IsNullOrEmpty(root) && Directory.Exists(root))
                {
                    List<BackupInfo> baks = SaveStore.ListBackups(root);
                    for (int i = 0; i < baks.Count; i++)
                    {
                        Dictionary<string, object> b = new Dictionary<string, object>();
                        b["name"] = Path.GetFileName(baks[i].FilePath);
                        b["path"] = baks[i].FilePath;
                        b["sha256"] = baks[i].Sha256;
                        list.Add(b);
                    }
                }
                r["backups"] = list;
                return r;
            }

            if (method == "restore_backup")
            {
                string backup = GetStr(p, "backup") ?? GetStr(p, "backupPath");
                string target = GetStr(p, "name") ?? GetStr(p, "target") ?? GetStr(p, "targetPath");
                string bPath = ResolveSafeChild(Path.Combine(root, "backups"), Path.GetFileName(backup));
                string tPath = ResolveSafeChild(root, target);
                SaveStore.RestoreBackup(bPath, tPath);
                Dictionary<string, object> r = new Dictionary<string, object>();
                r["name"] = Path.GetFileName(tPath);
                r["path"] = tPath;
                return r;
            }

            throw new InvalidOperationException("Unknown method: " + method);
        }
    }

    internal static class SelfTest
    {
        public static int Run(string outDir, string seedSavePath)
        {
            outDir = Path.GetFullPath(outDir);
            SaveStore.NoLinks(outDir, true);
            Directory.CreateDirectory(outDir);
            string root = Path.Combine(outDir, "root");
            if (Directory.Exists(root))
            {
                try { Directory.Delete(root, true); } catch { }
            }
            Directory.CreateDirectory(root);

            string target = Path.Combine(root, "PlayerData_1.save");
            if (!string.IsNullOrEmpty(seedSavePath))
            {
                if (!File.Exists(seedSavePath)) throw new FileNotFoundException("seed not found", seedSavePath);
                File.Copy(seedSavePath, target, true);
            }
            else
            {
                string json = "{\"firstName\":\"이름\",\"lastName\":\"무명\",\"sliver\":100,\"gold\":50,\"attribute\":1,\"gameLv\":0,\"HP\":100,\"baoShi\":50,\"ArrestNum\":0,\"m_allSkillList\":{},\"listMyItemData\":[],\"listMyEuipData\":[]}";
                byte[] bytes = SaveStore.EncodeSaveBytes("1", json);
                File.WriteAllBytes(target, bytes);
            }

            Environment.SetEnvironmentVariable("POKF_SAVE_ROOT", root);

            string wv2Parent = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "PathOfKungFuSaveEditor");
            SaveStore.NoLinks(wv2Parent, true);
            Directory.CreateDirectory(wv2Parent);
            string wv2Dir = Path.Combine(wv2Parent, "selftest-wv2");
            SaveStore.NoLinks(wv2Dir, true);
            Directory.CreateDirectory(wv2Dir);

            bool ok = true;
            string err = null;
            int tabCount = -1;
            int hanziCount = -1;
            string badgeText = "";
            bool silverOk = false;
            bool backupExists = false;
            bool validateOk = false;
            string webViewVersion = "";

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            MainForm form = new MainForm();
            form.ShowInTaskbar = false;
            form.WindowState = FormWindowState.Minimized;
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new Point(-32000, -32000);
            form.Opacity = 0;
            form.Show();

            try
            {
                Task initTask = form.InitializeWebViewCoreAsync(wv2Dir);
                if (!WaitTask(initTask, 30000)) throw new TimeoutException("webview init timeout");
                webViewVersion = form.WebViewVersion ?? "";

                if (!WaitReady(form, 30000)) throw new TimeoutException("ui readiness timeout");

                tabCount = ToInt(Eval(form, "document.querySelectorAll('[role=\"tab\"]').length"));
                hanziCount = ToInt(Eval(form, "/[\\u3400-\\u9fff]/.test(document.body.innerText) ? 1 : 0"));
                object b = Eval(form, "(function(){var e=document.getElementById('conn-badge');return e?e.textContent:'';})()");
                badgeText = b == null ? "" : Convert.ToString(b);

                Eval(form, "(function(){var s=document.getElementById('sliver');var g=document.getElementById('gold');"
                    + "if(s){s.value='12345';s.dispatchEvent(new Event('input',{bubbles:true}));}"
                    + "if(g){g.value='777';g.dispatchEvent(new Event('input',{bubbles:true}));}"
                    + "var b=document.getElementById('btn-save');if(b){b.click();return true;}return false;})()");

                string backupsDir = Path.Combine(root, "backups");
                JavaScriptSerializer ser = new JavaScriptSerializer();
                int deadline = Environment.TickCount + 15000;
                while (Environment.TickCount < deadline)
                {
                    Application.DoEvents();
                    backupExists = Directory.Exists(backupsDir) && Directory.GetFiles(backupsDir, "*.bak", SearchOption.TopDirectoryOnly).Length > 0;
                    if (backupExists)
                    {
                        try
                        {
                            SaveLoadResult sd = SaveStore.LoadSlot(target);
                            if (sd != null && !string.IsNullOrEmpty(sd.JsonText))
                            {
                                validateOk = true;
                                Dictionary<string, object> parsed = ser.Deserialize<Dictionary<string, object>>(sd.JsonText);
                                if (parsed != null && parsed.ContainsKey("sliver"))
                                {
                                    silverOk = Convert.ToInt64(parsed["sliver"], CultureInfo.InvariantCulture) == 12345;
                                }
                            }
                        }
                        catch { silverOk = false; }
                    }
                    if (backupExists && silverOk && validateOk) break;
                    Thread.Sleep(100);
                }
            }
            catch (Exception ex)
            {
                ok = false;
                err = ex.Message;
            }
            finally
            {
                try { form.Close(); } catch { }
                try { form.Dispose(); } catch { }
            }

            if (tabCount != 6) ok = false;
            if (hanziCount != 0) ok = false;
            if (badgeText != "네이티브 연결됨") ok = false;
            if (!silverOk || !backupExists || !validateOk) ok = false;

            StringBuilder sb = new StringBuilder();
            sb.Append("{");
            sb.Append("\"ok\":").Append(ok ? "true" : "false");
            sb.Append(",\"webViewVersion\":").Append(Q(webViewVersion));
            sb.Append(",\"tabCount\":").Append(tabCount.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"hanziCount\":").Append(hanziCount.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"badgeText\":").Append(Q(badgeText));
            sb.Append(",\"silverOk\":").Append(silverOk ? "true" : "false");
            sb.Append(",\"backupExists\":").Append(backupExists ? "true" : "false");
            sb.Append(",\"validateOk\":").Append(validateOk ? "true" : "false");
            if (err != null) sb.Append(",\"error\":").Append(Q(err));
            sb.Append("}");
            File.WriteAllText(Path.Combine(outDir, "receipt.json"), sb.ToString(), new UTF8Encoding(false));

            return ok ? 0 : 1;
        }

        private static string Q(string s)
        {
            return new JavaScriptSerializer().Serialize(s ?? "");
        }

        private static bool WaitTask(Task t, int ms)
        {
            int deadline = Environment.TickCount + ms;
            while (!t.IsCompleted && Environment.TickCount < deadline)
            {
                Application.DoEvents();
                Thread.Sleep(20);
            }
            if (t.IsFaulted && t.Exception != null)
                throw t.Exception.GetBaseException();
            return t.IsCompleted && !t.IsFaulted && !t.IsCanceled;
        }

        private static bool WaitReady(MainForm form, int ms)
        {
            return WaitFor(form, "document.readyState==='complete' && document.querySelectorAll('[role=\"tab\"]').length===6 && document.getElementById('conn-badge') && document.getElementById('conn-badge').textContent==='네이티브 연결됨' && !!document.getElementById('sliver')", ms);
        }

        private static bool WaitFor(MainForm form, string expr, int ms)
        {
            int until = Environment.TickCount + ms;
            while (Environment.TickCount < until)
            {
                object v = Eval(form, expr);
                if (v is bool && (bool)v) return true;
                Application.DoEvents();
                Thread.Sleep(100);
            }
            return false;
        }

        private static int ToInt(object o)
        {
            if (o == null) return -1;
            try { return Convert.ToInt32(o, CultureInfo.InvariantCulture); }
            catch { return -1; }
        }

        private static object Eval(MainForm form, string expr)
        {
            try
            {
                WebView2 wv = form.GetWebView();
                if (wv == null || wv.CoreWebView2 == null) return null;
                Task<string> t = wv.CoreWebView2.ExecuteScriptAsync(expr);
                int deadline = Environment.TickCount + 10000;
                while (!t.IsCompleted && Environment.TickCount < deadline)
                {
                    Application.DoEvents();
                    Thread.Sleep(10);
                }
                if (!t.IsCompleted || t.IsFaulted) return null;
                string s = t.Result;
                if (string.IsNullOrEmpty(s)) return null;
                if (s == "true") return true;
                if (s == "false") return false;
                if (s == "null") return null;
                return new JavaScriptSerializer().DeserializeObject(s);
            }
            catch { return null; }
        }
    }
}
