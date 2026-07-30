using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

internal sealed class ConsoleSecurityWindow : Window
{
    private readonly TextBox usernameBox = new TextBox();
    private readonly PasswordBox passwordBox = new PasswordBox();
    private readonly PasswordBox confirmBox = new PasswordBox();
    private readonly CheckBox revokeBox = new CheckBox { Content = "同时撤销所有已记住的浏览器" };
    public string Username { get { return usernameBox.Text.Trim(); } }
    public string Password { get { return passwordBox.Password; } }
    public bool RevokeDevices { get { return revokeBox.IsChecked == true; } }
    public ConsoleSecurityWindow(string username)
    {
        Title = "控制台安全"; Width = 470; Height = 390; ResizeMode = ResizeMode.NoResize; WindowStartupLocation = WindowStartupLocation.CenterOwner;
        FontFamily = new FontFamily("Microsoft YaHei UI"); Icon = NativeClient.LoadIconImage();
        StackPanel panel = new StackPanel { Margin = new Thickness(24) }; Content = panel;
        panel.Children.Add(new TextBlock { Text = "管理员账号", FontSize = 20, FontWeight = FontWeights.Bold });
        panel.Children.Add(new TextBlock { Text = "网页控制台使用独立账号。密码仅以当前 Windows 用户加密保存。", Margin = new Thickness(0, 8, 0, 16), Foreground = new SolidColorBrush(Color.FromRgb(100,116,139)), TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(new TextBlock { Text = "用户名" }); usernameBox.Text = username; usernameBox.Height = 31; panel.Children.Add(usernameBox);
        panel.Children.Add(new TextBlock { Text = "新密码（至少 10 位）", Margin = new Thickness(0, 12, 0, 4) }); passwordBox.Height = 31; panel.Children.Add(passwordBox);
        panel.Children.Add(new TextBlock { Text = "确认新密码", Margin = new Thickness(0, 12, 0, 4) }); confirmBox.Height = 31; panel.Children.Add(confirmBox);
        revokeBox.Margin = new Thickness(0, 14, 0, 0); panel.Children.Add(revokeBox);
        StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 22, 0, 0) };
        Button cancel = new Button { Content = "取消", Width = 90, Height = 32 }; Button save = new Button { Content = "保存", Width = 90, Height = 32, Margin = new Thickness(10,0,0,0), IsDefault = true };
        cancel.Click += delegate { DialogResult = false; };
        save.Click += delegate { if (Username == "" || Password.Length < 10) { MessageBox.Show("请填写用户名和至少 10 位的新密码。", Program.AppName); return; } if (Password != confirmBox.Password) { MessageBox.Show("两次密码不一致。", Program.AppName); return; } DialogResult = true; };
        actions.Children.Add(cancel); actions.Children.Add(save); panel.Children.Add(actions);
    }
}
