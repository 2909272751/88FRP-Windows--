using System;
using System.Collections.Generic;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;

internal static class NativeEditingRegression
{
    private static object Field(MainWindow window, string name) { return typeof(MainWindow).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(window); }
    private static void Call(MainWindow window, string name) { typeof(MainWindow).GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic).Invoke(window, name == "RefreshInstances" ? new object[] { true } : null); }
    private static void Require(bool ok, string message) { if (!ok) throw new Exception(message); }
    [STAThread]
    private static void Main(string[] args)
    {
        Program.ConsolePort = Int32.Parse(args[0]);
        App app = new App();
        MainWindow window = new MainWindow(false);
        try {
            Call(window, "RefreshInstances");
            var inputs = (Dictionary<string, TextBox>)Field(window, "tunnelGroupInputs");
            var checks = (Dictionary<string, CheckBox>)Field(window, "tunnelChecks");
            TextBox editor = inputs["fixture-tunnel"];
            editor.Text = "未保存的中文分组";
            editor.CaretIndex = 4;
            checks["fixture-tunnel"].IsChecked = true;
            ((TextBox)Field(window, "configBox")).Text = "unsaved configuration";
            ((TextBox)Field(window, "secretBox")).Text = "unsaved secret";
            for (int i = 0; i < 4; i++) Call(window, "RefreshInstances");
            Require(Object.ReferenceEquals(editor, inputs["fixture-tunnel"]), "Polling recreated the group editor");
            Require(editor.Text == "未保存的中文分组" && editor.CaretIndex == 4, "Polling discarded text or caret");
            Require(checks["fixture-tunnel"].IsChecked == true, "Polling discarded selection");
            Require(((TextBox)Field(window, "configBox")).Text == "unsaved configuration", "Polling discarded config draft");
            Require(((TextBox)Field(window, "secretBox")).Text == "unsaved secret", "Polling discarded sync draft");
            Require(((TextBlock)Field(window, "pidValue")).Text == "1234", "Runtime status stopped updating");
            Console.WriteLine("PASS: runtime polls preserve editor identity, Chinese text, caret, selection and drafts");
        } finally { ((System.Windows.Forms.NotifyIcon)Field(window, "trayIcon")).Dispose(); }
    }
}
