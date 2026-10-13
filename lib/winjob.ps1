# Windows helper for lib/exec.mjs runShell: runs $env:FF_CMD in a job object so every descendant, including
# orphans, is killed together. Control: a byte on stdin (or stdin EOF) terminates the job. Exit code: the command's.
# Diagnostics go to stderr as lines prefixed with \x01FFJOB so exec.mjs can strip and parse them.
if ($env:FF_TEST_STALL -eq '1') { Start-Sleep 30 } # test seam: a helper that never gets as far as starting the command
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class FFJob {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int n; public IntPtr d; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI { public int cb; public string r, desk, title; public int x, y, xs, ys, xc, yc, fill, flags; public short show, r2; public IntPtr r2p, hin, hout, herr; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hp, ht; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a, b; public uint flags; public UIntPtr minws, maxws; public uint active; public UIntPtr aff; public uint prio, sched; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC basic; public IOC io; public UIntPtr pm, jm, peak, jpeak; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int c, IntPtr i, int len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr j, uint code);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFile(string f, uint access, uint share, ref SA sa, uint disp, uint attrs, IntPtr t);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr p, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PE { public uint size, usage, pid; public UIntPtr heap; public uint module, threads, ppid; public int prio; public uint flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref PE e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref PE e);

  // PIDs still linked to root through parent ids, from a native snapshot (no WMI, which restricted sandboxes deny); null on failure.
  static List<int> Linked(int root, out int err) {
    err = 0;
    IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
    if (snap == new IntPtr(-1)) { err = Marshal.GetLastWin32Error(); return null; }
    var rows = new List<int[]>();
    var e = new PE(); e.size = (uint)Marshal.SizeOf(typeof(PE));
    for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e)) rows.Add(new int[] { (int)e.pid, (int)e.ppid });
    CloseHandle(snap);
    var found = new HashSet<int> { root };
    for (bool grew = true; grew;) { grew = false; foreach (var r in rows) if (!found.Contains(r[0]) && found.Contains(r[1])) { found.Add(r[0]); grew = true; } }
    found.Remove(root);
    return new List<int>(found);
  }

  static void Note(string s) { Console.Error.Write("\n\u0001FFJOB " + s + "\n"); Console.Error.Flush(); }

  // PIDs in the job, or null (with err set) when the query fails: an unknown membership must not read as an empty job.
  // Grows the buffer on ERROR_MORE_DATA. FF_TEST_BUF (entries) and FF_TEST_QUERYFAIL are test seams.
  static List<int> Members(IntPtr job, out int err) {
    err = 0;
    if (Environment.GetEnvironmentVariable("FF_TEST_QUERYFAIL") == "1") { err = 5; return null; }
    int cap;
    if (!int.TryParse(Environment.GetEnvironmentVariable("FF_TEST_BUF"), out cap) || cap < 1) cap = 512;
    for (int attempt = 0; attempt < 6; attempt++, cap *= 4) {
      int size = 8 + IntPtr.Size * cap;
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        if (QueryInformationJobObject(job, 3, buf, size, IntPtr.Zero)) {
          var l = new List<int>();
          int n = Marshal.ReadInt32(buf, 4);
          for (int i = 0; i < n; i++) l.Add((int)(long)Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size));
          return l;
        }
        err = Marshal.GetLastWin32Error();
        if (err != 234) return null; // ERROR_MORE_DATA: retry with a larger buffer
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return null;
  }

  // deny: test seam, leave the job (and its processes) running and report them as survivors.
  public static int Run(string cmdline, string cwd, bool deny) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    var ext = new EXT();
    // KILL_ON_JOB_CLOSE, plus BREAKAWAY_OK: without it a tool that asks for CREATE_BREAKAWAY_FROM_JOB fails to start its
    // child (error 5) where it would have worked before. Children that ask to break away are deliberately outside the job.
    if (!deny) ext.basic.flags = 0x2000 | 0x800;
    else ext.basic.flags = 0x800;
    bool jobOk = job != IntPtr.Zero && SetInformationJobObject(job, 9, ref ext, Marshal.SizeOf(typeof(EXT)));
    if (Environment.GetEnvironmentVariable("FF_TEST_NOJOB") == "1") jobOk = false; // test seam: pretend the job could not be set up
    if (!jobOk) Note("nojob " + Marshal.GetLastWin32Error());

    // the control pipe must not leak into the command or its descendants, or ff would never see EOF/close
    SetHandleInformation(GetStdHandle(-10), 1, 0);
    var sa = new SA(); sa.n = Marshal.SizeOf(typeof(SA)); sa.inherit = 1;
    IntPtr nul = CreateFile("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero);
    var si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); si.flags = 0x100; // USESTDHANDLES: stdin is NUL, not our control pipe
    si.hin = nul; si.hout = GetStdHandle(-11); si.herr = GetStdHandle(-12);
    PI pi;
    // SUSPENDED so the process cannot spawn anything before it is in the job; BREAKAWAY is not requested.
    // No CREATE_NO_WINDOW: it would start a conhost.exe inside the job that outlives the command and reads as a leftover;
    // the command shares this helper's hidden console instead.
    if (!CreateProcess(null, cmdline, IntPtr.Zero, IntPtr.Zero, true, 0x4, IntPtr.Zero, cwd, ref si, out pi)) {
      Note("fail " + Marshal.GetLastWin32Error());
      return 127;
    }
    if (jobOk && !AssignProcessToJobObject(job, pi.hp)) { Note("noassign " + Marshal.GetLastWin32Error()); jobOk = false; }
    ResumeThread(pi.ht);
    Note("started " + pi.pid);

    bool kill = false;
    var reader = new Thread(() => { try { Console.OpenStandardInput().ReadByte(); } catch { } kill = true; }) { IsBackground = true };
    reader.Start();
    while (!kill && WaitForSingleObject(pi.hp, 50) != 0) { }
    if (!kill) {
      // finished on its own: like a plain spawn, leave any background leftovers running
      if (jobOk) { int e0; var left0 = Members(job, out e0); if (left0 != null && left0.Count > 0) Note("leftover " + string.Join(",", left0)); var keep = new EXT(); SetInformationJobObject(job, 9, ref keep, Marshal.SizeOf(typeof(EXT))); }
      uint code; GetExitCodeProcess(pi.hp, out code); return (int)code;
    }

    if (!deny) {
      // without a job leave the root alive: ff's taskkill /T needs its pid to find the children it still links to,
      // and list those children now, while the links exist, so they can be named if the kill is refused
      if (!jobOk) { int le; var kids = Linked(pi.pid, out le); Note(kids == null ? "linkedfail " + le : "linked " + string.Join(",", kids)); }
      if (jobOk && !TerminateJobObject(job, 1)) Note("termfail " + Marshal.GetLastWin32Error());
    }
    var left = new List<int>();
    for (int i = 0; i < 20; i++) {
      if (jobOk) {
        int err; left = Members(job, out err);
        if (left == null) { Note("unknown " + err); return 98; } // cannot tell what is still running
      } else { left = WaitForSingleObject(pi.hp, 0) == 0 ? new List<int>() : new List<int> { pi.pid }; break; }
      if (left.Count == 0) break;
      Thread.Sleep(50);
    }
    Note("survivors " + string.Join(",", left));
    return 98;
  }
}
'@
exit [FFJob]::Run($env:FF_CMD, $(if ($env:FF_CWD) { $env:FF_CWD }), $env:FF_DENY -eq '1')
